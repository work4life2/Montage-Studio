import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { editToBeat, probeDuration, probeVideo } from "../media/edit.js";
import { download } from "../media/util.js";
import { run, sleep } from "../util/exec.js";
import { termix } from "../termix/client.js";
import { Split, type SplitPanel, type SubtaskItem } from "../termix/split.js";
import type { ProductionPlan } from "../roles/montage.js";
import type { Deliverable } from "../roles/types.js";
import type { SketchSpec } from "../roles/sketchboard.js";
import type { RenderSpec } from "../roles/renderfarm.js";
import type { SongSpec } from "../roles/beatsmith.js";
import { priceRender } from "../roles/renderfarm.js";
import { priceSong } from "../roles/beatsmith.js";
import { sketchboard } from "../roles/sketchboard.js";
import { saveJob, type Job } from "./store.js";

const log = logger("production");

export type CrewRole = "sketchboard" | "beatsmith" | "renderfarm";

export interface CrewTask {
  role: CrewRole;
  title: string;
  scope: string;
  amount: string;
  dueAt: string;
  status: "planned" | "created" | "invited" | "proposed" | "accepted" | "delivered" | "released" | "failed";
  subtaskId?: string;
  pairConversationId?: string;
  briefUrl?: string;
  childOrderId?: string;
  proposals: number;
  proposedAt?: string;
  redoRequested?: boolean;
  files: Record<string, string>;
  txHashes: Record<string, string>;
  notes: string[];
}

export interface Production {
  plan?: ProductionPlan;
  team?: string;
  kickedOff?: boolean;
  crew: Partial<Record<CrewRole, CrewTask>>;
  keyframes?: Record<string, string>;
  keyframeUrls?: Record<string, string>;
  contactSheet?: string;
  clips?: Record<string, string>;
  audio?: string;
  posted: string[];
}

const BRIEF_VERSION = 1;

function prod(job: Job): Production {
  const p = (job.production ??= { crew: {}, posted: [] }) as Production;
  p.crew ??= {};
  p.posted ??= [];
  return p;
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");

/** Post a team-channel update once per key (restarts must not repeat them). */
async function teamPost(job: Job, p: Production, key: string, text: string): Promise<void> {
  if (!p.team || p.posted.includes(key)) return;
  try {
    await new Split(termix("montage")).post(p.team, text);
    p.posted.push(key);
    saveJob(job);
  } catch (err) {
    log.warn(`${job.id}: team post "${key}" failed: ${String(err).slice(0, 200)}`);
  }
}

function clamp(t: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, t));
}

function dueAt(panel: SplitPanel, fraction: number): string {
  const now = Date.now();
  const cap = Date.parse(panel.dueCap);
  const t = clamp(now + (cap - now) * fraction, now + 2 * 3600_000, cap - 3600_000);
  return new Date(Math.min(t, cap - 120_000)).toISOString();
}

/** The crew's own cost-plus prices for exactly this plan (sub-tasks carry no platform fee). */
function crewPrices(plan: ProductionPlan) {
  const n = plan.shots.length;
  const avg = plan.shots.reduce((a, s) => a + s.seconds, 0) / Math.max(1, n);
  const rfMusic = plan.music.source === "renderfarm" ? { music: plan.music.instrumental ? "instrumental" : "song", musicSeconds: plan.durationSec + 30, musicTakes: 2 } : {};
  return {
    sketchboard: sketchboard.price({ keyframes: n, characterSheets: plan.characters.length, aspect: plan.aspect }, { subtask: true }).price,
    renderfarm: priceRender({ shots: n, secondsPerShot: avg, resolution: plan.resolution, fps60: plan.fps === 60, ...rfMusic }, { subtask: true }).price,
    beatsmith: priceSong({ takes: 2, engine: "lyria", lyrics: plan.music.instrumental ? "none" : "write" }, { subtask: true }).price,
  };
}

function sketchBrief(plan: ProductionPlan): SketchSpec {
  return {
    title: plan.title,
    aspect: plan.aspect,
    style: plan.style,
    characters: plan.characters,
    shots: plan.shots.map((s) => ({ id: s.id, description: s.description, characters: s.characters })),
  };
}

function songBrief(plan: ProductionPlan): SongSpec {
  return {
    title: plan.music.title ?? plan.title,
    style: plan.music.style ?? "",
    lyrics: plan.music.instrumental ? "" : (plan.music.lyrics ?? ""),
    instrumental: Boolean(plan.music.instrumental),
    bpm: plan.music.bpm,
    minSeconds: Math.ceil(plan.durationSec + 15),
    takes: 2,
    engine: "lyria",
  };
}

function renderBrief(plan: ProductionPlan, urls: Record<string, string>): RenderSpec {
  return {
    title: plan.title,
    aspect: plan.aspect,
    resolution: plan.resolution,
    fps60: plan.fps === 60,
    shots: plan.shots.map((s) => ({ id: s.id, seconds: s.seconds, prompt: s.motion, image: urls[s.id] })),
    music:
      plan.music.source === "renderfarm"
        ? { prompt: plan.music.style ?? "cinematic instrumental", lyrics: plan.music.instrumental ? "" : plan.music.lyrics, instrumental: Boolean(plan.music.instrumental), seconds: plan.durationSec + 30, takes: 2, title: plan.music.title ?? plan.title }
        : undefined,
  };
}

/** Create → invite (+ brief in the 1:1 thread) → propose on-chain. Each step persists, so a restart resumes. */
async function advance(job: Job, p: Production, task: CrewTask, brief: () => Promise<unknown>, beforeBrief?: (conversationId: string) => Promise<void>): Promise<void> {
  const t = termix("montage");
  const split = new Split(t);
  const cfg = getConfig();
  const target = cfg.agents[task.role].agentId;
  if (task.status === "planned") {
    const st = await split.create(job.orderId, { title: task.title, scope: task.scope.slice(0, 4000), amount: task.amount, dueAt: task.dueAt, skills: [task.role] });
    task.subtaskId = st.id;
    task.status = "created";
    saveJob(job);
    log.info(`${job.id}: sub-task ${st.id} for ${task.role} (${task.amount} ${cfg.currency}, due ${task.dueAt})`);
  }
  if (task.status === "created") {
    const inv = await split.invite(task.subtaskId!, target);
    task.pairConversationId = inv.conversationId;
    saveJob(job);
    if (beforeBrief) await beforeBrief(inv.conversationId);
    const file = path.join(job.dir, "crew", task.role, `brief-${task.subtaskId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: BRIEF_VERSION, from: "montage-studio", subtaskId: task.subtaskId, rootOrderId: job.orderId, spec: await brief() }, null, 2));
    const att = await split.attach(inv.conversationId, file, "application/json");
    task.briefUrl = att.url;
    await split.post(inv.conversationId, `Brief for sub-task "${task.title}" (${task.subtaskId}) is attached as brief-${task.subtaskId}.json. ${task.scope.slice(0, 600)}`);
    task.status = "invited";
    saveJob(job);
  }
  if (task.status === "invited") {
    // A proposal we signed earlier may still be waiting for the indexer (the panel shows DRAFT with a
    // pending agent until then); proposing again would be refused, and is not needed.
    const item = (await split.panel(job.orderId)).items.find((i) => i.id === task.subtaskId);
    if (item && (item.status !== "DRAFT" || item.pendingAgent?.id === target)) {
      task.status = "proposed";
      task.proposedAt ??= new Date().toISOString();
      saveJob(job);
      return;
    }
    try {
      const tx = await split.assign(task.subtaskId!, target, { rootOrderId: job.orderId, role: task.role });
      task.txHashes[`propose${task.proposals ? `-${task.proposals + 1}` : ""}`] = tx.results?.[0]?.txHash ?? "";
      log.info(`${job.id}: proposed ${task.role} on-chain (${tx.results?.[0]?.txHash ?? "pending"})`);
    } catch (err) {
      if (!/already signed|on-chain and will show/i.test(String(err))) throw err;
      log.info(`${job.id}: ${task.role} proposal already on-chain, waiting for the indexer`);
    }
    task.proposals += 1;
    task.proposedAt = new Date().toISOString();
    task.status = "proposed";
    saveJob(job);
  }
}

/** Download the delivered artifacts of a child order (participants get short-lived signed URLs). */
async function collect(job: Job, task: CrewTask): Promise<void> {
  const t = termix("montage");
  const o = await t.get<{ artifacts?: Array<{ url: string; s3Key: string; contentType: string }> }>(`/api/v1/orders/${task.childOrderId}`);
  const dir = path.join(job.dir, "crew", task.role, "delivery");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  task.files = {};
  for (const a of o.artifacts ?? []) {
    const name = path.basename(a.s3Key).replace(/^[0-9a-f-]{36}-/, "");
    task.files[name] = await download(a.url, path.join(dir, name));
  }
  saveJob(job);
}

async function unzip(zipFile: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const res = await run("unzip", ["-o", "-q", zipFile, "-d", dest], { timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error(`unzip ${zipFile}: ${res.stderr.slice(-300)}`);
}

/** The take to cut to: the shortest one that covers the video, else the longest. */
async function pickTake(files: string[], durationSec: number): Promise<{ file?: string; seconds: number }> {
  const lengths = await Promise.all(files.map(async (f) => ({ f, d: await probeDuration(f).catch(() => 0) })));
  const fit = lengths.filter((x) => x.d >= durationSec).sort((a, b) => a.d - b.d)[0] ?? lengths.sort((a, b) => b.d - a.d)[0];
  return { file: fit?.f, seconds: fit?.d ?? 0 };
}

/** Check a delivery against the plan. Returns what is missing (empty = accept). */
async function review(job: Job, p: Production, task: CrewTask): Promise<string[]> {
  const plan = p.plan!;
  const problems: string[] = [];
  if (task.role === "sketchboard") {
    const zip = Object.entries(task.files).find(([n]) => n.endsWith(".zip"))?.[1];
    if (!zip) return ["storyboard.zip is missing"];
    const dest = path.join(job.dir, "crew", "sketchboard", "unpacked");
    await unzip(zip, dest);
    p.keyframes = {};
    for (const s of plan.shots) {
      const f = path.join(dest, "keyframes", `${s.id}.png`);
      if (fs.existsSync(f)) p.keyframes[s.id] = f;
      else problems.push(`keyframe ${s.id} missing`);
    }
    p.contactSheet = Object.entries(task.files).find(([n]) => n.endsWith(".jpg"))?.[1];
  } else if (task.role === "renderfarm") {
    const zip = Object.entries(task.files).find(([n]) => n.endsWith(".zip"))?.[1];
    if (!zip) return ["clips.zip is missing"];
    const dest = path.join(job.dir, "crew", "renderfarm", "unpacked");
    await unzip(zip, dest);
    p.clips = {};
    for (const s of plan.shots) {
      const f = path.join(dest, "clips", `${s.id}.mp4`);
      try {
        const v = await probeVideo(f);
        if (v.duration < 1) problems.push(`clip ${s.id} is only ${v.duration.toFixed(1)} s`);
        else p.clips[s.id] = f;
      } catch {
        problems.push(`clip ${s.id} missing or unreadable`);
      }
    }
    if (plan.music.source === "renderfarm") {
      const takes = Object.entries(task.files).filter(([n]) => /\.(wav|mp3|m4a)$/i.test(n)).map(([, f]) => f);
      const pick = await pickTake(takes, plan.durationSec);
      if (!pick.file) problems.push("music missing");
      else if (pick.seconds < Math.min(15, plan.durationSec)) problems.push(`music too short (${Math.round(pick.seconds)} s)`);
      else p.audio = pick.file;
    }
  } else if (task.role === "beatsmith") {
    const takes = Object.entries(task.files).filter(([n]) => /\.(wav|mp3|m4a|flac)$/i.test(n)).map(([, f]) => f);
    if (!takes.length) return ["no audio files"];
    const pick = await pickTake(takes, plan.durationSec);
    if (!pick.file || pick.seconds < Math.min(20, plan.durationSec)) problems.push(`the takes are too short for a ${plan.durationSec} s video`);
    else p.audio = pick.file;
  }
  saveJob(job);
  return problems;
}

/** Poll the split panel until every task in `roles` is released (delivery reviewed + escrow released). */
async function waitFor(job: Job, p: Production, roles: CrewRole[], deadline: number): Promise<void> {
  const t = termix("montage");
  const split = new Split(t);
  while (true) {
    const pending = roles.map((r) => p.crew[r]).filter((x): x is CrewTask => Boolean(x) && x!.status !== "released");
    if (!pending.length) return;
    if (Date.now() > deadline) throw new Error(`crew did not deliver in time: ${pending.map((x) => `${x.role}=${x.status}`).join(", ")}`);
    const panel = await split.panel(job.orderId);
    for (const task of pending) {
      const item = panel.items.find((i: SubtaskItem) => i.id === task.subtaskId);
      if (!item) continue;
      const child = item.childOrder;
      const stale = !task.proposedAt || Date.now() - Date.parse(task.proposedAt) > 15 * 60_000;
      if (task.status === "proposed" && item.status === "DRAFT" && !item.pendingAgent && stale) {
        // Proposal declined or expired: propose again (twice at most), else give up loudly.
        task.notes.push(`proposal closed at ${new Date().toISOString()}`);
        if (task.proposals >= 3) {
          task.status = "failed";
          saveJob(job);
          await notify("production.crew_failed", { orderId: job.orderId, role: task.role, subtaskId: task.subtaskId });
          throw new Error(`${task.role} never accepted sub-task ${task.subtaskId}`);
        }
        task.status = "invited";
        await advance(job, p, task, async () => ({}));
        continue;
      }
      if (item.status === "CANCELLED") {
        task.status = "failed";
        saveJob(job);
        throw new Error(`${task.role} sub-task ${task.subtaskId} was cancelled (${child?.outcome ?? "?"})`);
      }
      if (child?.id && !task.childOrderId) {
        task.childOrderId = child.id;
        task.status = "accepted";
        saveJob(job);
        log.info(`${job.id}: ${task.role} accepted (child order ${child.id})`);
      }
      if (child?.status === "DELIVERED" && task.status !== "delivered") {
        await collect(job, task);
        const problems = await review(job, p, task);
        if (problems.length && !task.redoRequested) {
          task.redoRequested = true;
          const note = `Please fix: ${problems.join("; ")}`;
          task.notes.push(note);
          saveJob(job);
          const r = await split.requestRedo(child.id, note);
          task.txHashes.redo = r.results?.[0]?.txHash ?? "";
          log.warn(`${job.id}: ${task.role} delivery incomplete, redo requested — ${note}`);
          continue;
        }
        if (problems.length) log.warn(`${job.id}: ${task.role} delivery still has issues after the redo, accepting what we have: ${problems.join("; ")}`);
        task.status = "delivered";
        saveJob(job);
      }
      if (task.status === "delivered") {
        const r = await split.release(child!.id);
        task.txHashes.release = r.results?.[0]?.txHash ?? "";
        task.status = "released";
        saveJob(job);
        log.info(`${job.id}: ${task.role} delivery approved and released`);
        await teamPost(job, p, `released-${task.role}`, `✅ ${task.title}: delivery reviewed and approved — thanks!`);
      } else if (child && ["SETTLED"].includes(child.status) && task.status !== "released") {
        task.status = "released";
        saveJob(job);
      }
    }
    await sleep(45_000);
  }
}

/**
 * Montage Studio's work for one funded order: direct (plan), hire the crew through sub-tasks,
 * review and release their deliveries, then cut the film to the beat. Resumable at every step.
 */
export async function runProduction(job: Job, plan: ProductionPlan): Promise<Deliverable> {
  const p = prod(job);
  p.plan = plan;
  saveJob(job);
  const t = termix("montage");
  const split = new Split(t);
  const cfg = getConfig();
  fs.writeFileSync(path.join(job.dir, "plan.json"), JSON.stringify(plan, null, 2));

  const panel = await split.panel(job.orderId);
  const deadline = Date.parse(panel.dueCap) - 30 * 60_000;
  if (!p.team) {
    const team = await split.team(job.orderId);
    p.team = team.conversation.id;
    saveJob(job);
  }
  const prices = crewPrices(plan);
  const cap = Number(panel.cap);
  const wanted = prices.sketchboard + prices.renderfarm + (plan.music.source === "beatsmith" ? prices.beatsmith : 0);
  if (wanted > cap) throw new Error(`crew costs ${fmt(wanted)} exceed the splittable cap ${panel.cap} — the plan grew past the quote`);
  await teamPost(
    job,
    p,
    "kickoff",
    `🎬 "${plan.title}" — ${plan.logline}\n${plan.shots.length} shots, ${plan.durationSec} s, ${plan.aspect} ${plan.resolution}@${plan.fps}. ` +
      `Crew: Sketchboard (storyboard)${plan.music.source === "beatsmith" ? ", Beatsmith (song)" : ""}, RenderFarm (renders${plan.music.source === "renderfarm" ? " + music" : ""}). Briefs go out in each 1:1 thread.`,
  );

  // Phase A: storyboard and song in parallel.
  if (!p.crew.sketchboard) {
    p.crew.sketchboard = {
      role: "sketchboard",
      title: "Storyboard keyframes",
      scope: `Storyboard for "${plan.title}": ${plan.shots.length} keyframes (${plan.aspect}) + ${plan.characters.length} character model sheet(s), style: ${plan.style}. Full shot list in brief JSON. Deliver storyboard.zip (keyframes/<shot id>.png, sheets/, manifest.json) + contact sheet.`,
      amount: fmt(prices.sketchboard),
      dueAt: dueAt(panel, 0.35),
      status: "planned",
      proposals: 0,
      files: {},
      txHashes: {},
      notes: [],
    };
  }
  if (plan.music.source === "beatsmith" && !p.crew.beatsmith) {
    p.crew.beatsmith = {
      role: "beatsmith",
      title: plan.music.instrumental ? "Instrumental track" : "Original song",
      scope: `${plan.music.instrumental ? "Instrumental" : "Original song"} for "${plan.title}" : ${plan.music.style ?? ""}${plan.music.bpm ? `, ~${plan.music.bpm} BPM` : ""}, at least ${Math.ceil(plan.durationSec + 15)} s. ${plan.music.instrumental ? "" : "Lyrics in brief JSON. "}2 takes. Deliver every take as audio + manifest.json.`,
      amount: fmt(prices.beatsmith),
      dueAt: dueAt(panel, 0.35),
      status: "planned",
      proposals: 0,
      files: {},
      txHashes: {},
      notes: [],
    };
  }
  saveJob(job);
  await advance(job, p, p.crew.sketchboard!, async () => sketchBrief(plan));
  if (p.crew.beatsmith) await advance(job, p, p.crew.beatsmith, async () => songBrief(plan));
  if (plan.music.source === "buyer" && plan.music.url && !p.audio) p.audio = await download(plan.music.url, path.join(job.dir, "crew", "buyer-track" + (path.extname(new URL(plan.music.url).pathname) || ".mp3")));

  await waitFor(job, p, ["sketchboard"], deadline);
  await teamPost(job, p, "storyboard", `🖼️ Storyboard approved (${Object.keys(p.keyframes ?? {}).length} keyframes). RenderFarm brief going out with the start frames.`);

  // Phase B: renders from the approved keyframes.
  if (!p.crew.renderfarm) {
    const panel2 = await split.panel(job.orderId);
    p.crew.renderfarm = {
      role: "renderfarm",
      title: "Shot renders",
      scope: `Image-to-video renders for "${plan.title}": ${plan.shots.length} shots, ${plan.resolution} ${plan.aspect}${plan.fps === 60 ? ", enhanced to 60 fps" : ""}. Start frames (keyframe URLs) and motion prompts in brief JSON.${plan.music.source === "renderfarm" ? ` Plus 2 takes of ${plan.music.instrumental ? "an instrumental track" : "a song with vocals (lyrics in brief JSON)"}, ≥ ${plan.durationSec + 30} s.` : ""} Deliver clips.zip (clips/<shot id>.mp4) + manifest.json + the music takes.`,
      amount: fmt(Math.min(prices.renderfarm, Number(panel2.remaining))),
      dueAt: dueAt(panel2, 0.75),
      status: "planned",
      proposals: 0,
      files: {},
      txHashes: {},
      notes: [],
    };
    saveJob(job);
  }
  // Keyframes go into RenderFarm's 1:1 thread as attachments (public URLs) before its brief is posted.
  const uploadFrames = async (conversationId: string) => {
    p.keyframeUrls ??= {};
    for (const s of plan.shots) {
      if (p.keyframeUrls[s.id] || !p.keyframes?.[s.id]) continue;
      p.keyframeUrls[s.id] = (await split.attach(conversationId, p.keyframes[s.id], "image/png")).url;
      saveJob(job);
    }
  };
  await advance(job, p, p.crew.renderfarm, async () => renderBrief(plan, p.keyframeUrls ?? {}), uploadFrames);
  await waitFor(job, p, ["renderfarm", ...(p.crew.beatsmith ? (["beatsmith"] as CrewRole[]) : [])], deadline);
  await teamPost(job, p, "renders", `🎞️ All ${plan.shots.length} renders${p.audio ? " and the music" : ""} approved. Cutting to the beat now.`);

  // Edit.
  const editDir = path.join(job.dir, "edit");
  fs.mkdirSync(editDir, { recursive: true });
  const slug = (plan.title || "montage").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "montage";
  const outName = `${slug}-${plan.resolution}${plan.fps}`;
  const result = await editToBeat({
    workDir: editDir,
    aspect: plan.aspect,
    resolution: plan.resolution,
    fps: plan.fps,
    shots: plan.shots.filter((s) => p.clips?.[s.id]).map((s) => ({ id: s.id, clip: p.clips![s.id], seconds: s.seconds, caption: s.caption })),
    audio: p.audio,
    targetSec: plan.durationSec,
    titleText: plan.titleText,
    endText: plan.endText,
    outName,
  });
  fs.writeFileSync(path.join(editDir, "cutlist.json"), JSON.stringify(result.cutlist, null, 2));

  // Production notes: the plan as readable text + JSON, the lyrics, the cut list, the contact sheet.
  const notesDir = path.join(job.dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "plan.json"), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(notesDir, "cutlist.json"), JSON.stringify(result.cutlist, null, 2));
  fs.writeFileSync(
    path.join(notesDir, "shot-list.md"),
    `# ${plan.title}\n\n${plan.logline}\n\nStyle: ${plan.style}\n\n` +
      plan.shots.map((s, i) => `## ${s.id} · ${fmt(result.cutlist[i]?.end - result.cutlist[i]?.start || s.seconds)} s\n- Frame: ${s.description}\n- Motion: ${s.motion}${s.caption ? `\n- Caption: ${s.caption}` : ""}`).join("\n\n") +
      "\n",
  );
  if (plan.music.lyrics) fs.writeFileSync(path.join(notesDir, "lyrics.txt"), plan.music.lyrics);
  if (p.contactSheet) fs.copyFileSync(p.contactSheet, path.join(notesDir, "storyboard-contact-sheet.jpg"));
  const notesZip = path.join(job.dir, "production-notes.zip");
  fs.rmSync(notesZip, { force: true });
  const z = await run("zip", ["-q", "-r", notesZip, "."], { cwd: notesDir, timeoutMs: 120_000 });
  if (z.code !== 0) throw new Error(`zip notes: ${z.stderr}`);

  const files: Deliverable["files"] = [
    { file: result.master, contentType: "video/mp4", label: path.basename(result.master) },
    { file: result.preview, contentType: "video/mp4", label: path.basename(result.preview) },
    { file: notesZip, contentType: "application/zip", label: "production-notes.zip" },
  ];
  if (p.audio && plan.music.source !== "buyer") {
    const ext = path.extname(p.audio) || ".mp3";
    files.push({ file: p.audio, contentType: ext === ".wav" ? "audio/wav" : "audio/mpeg", label: `${slug}-song${ext}` });
  }
  if (p.contactSheet) files.push({ file: p.contactSheet, contentType: "image/jpeg", label: "storyboard-contact-sheet.jpg" });
  await teamPost(job, p, "final", `📦 Final cut ready (${fmt(result.durationSec)} s). Delivering to the client. Payouts unlock once the client's order settles.`);

  const crewLine = (["sketchboard", "beatsmith", "renderfarm"] as CrewRole[])
    .filter((r) => p.crew[r])
    .map((r) => `${r === "sketchboard" ? "Sketchboard" : r === "beatsmith" ? "Beatsmith" : "RenderFarm"}`)
    .join(", ");
  return {
    files,
    note:
      `"${plan.title}" — ${fmt(result.durationSec)} s, ${plan.aspect} ${plan.resolution}@${plan.fps}fps, ${plan.shots.length} shots cut to the beat${result.tempo ? ` (${Math.round(result.tempo)} BPM)` : ""}. ` +
      `Files: master MP4, 720p preview, ${p.audio && plan.music.source !== "buyer" ? "song, " : ""}storyboard contact sheet, production-notes.zip (shot list, lyrics, plan, cut list). Crew: ${crewLine}.`,
    summary:
      `✅ Your video "${plan.title}" is delivered: the ${plan.resolution} master (${fmt(result.durationSec)} s, ${plan.aspect}), a 720p preview, ${p.audio && plan.music.source !== "buyer" ? "the song, " : ""}the storyboard and the production notes. ` +
      `Please review it on the order page. If the edit needs changes (order, timing, titles), request a redo once and we will recut it.`,
  };
}
