import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { asAspect, download, pool, zip, type Aspect } from "../media/util.js";
import { probeVideo } from "../media/edit.js";
import { costPlus, gasLine, llmLine, num } from "../pricing.js";
import { chatJson } from "../relay.js";
import { recordSpend, saveJob, type Job } from "../jobs/store.js";
import { RUNWAY, runwayEnhanceFps, runwayImageToVideo, runwayMusic, runwayTextToVideo } from "../providers/runway.js";
import type { Deliverable, RoleSpec } from "./types.js";

const log = logger("renderfarm");

export interface RenderShot {
  id: string;
  /** Wanted on-screen length; the clip is rendered one second longer (3–15 s) so the edit can pick the best part. */
  seconds: number;
  prompt: string;
  /** Start frame (URL). Without one the shot is text-to-video. */
  image?: string;
}

export interface RenderMusic {
  /** Style prompt: genre, tempo, instruments, mood (and vocal type for a song). */
  prompt: string;
  /** Lyrics for a song with vocals; empty = instrumental. */
  lyrics?: string;
  instrumental: boolean;
  seconds: number;
  /** Generations (takes) to choose from. */
  takes: number;
  title?: string;
}

export interface RenderSpec {
  title?: string;
  aspect: Aspect;
  resolution: "720p" | "1080p";
  fps60: boolean;
  shots: RenderShot[];
  /** Optional music made with Runway's music models (a song with vocals, or an instrumental bed). */
  music?: RenderMusic;
}

const MAX_SHOTS = 80;
/** Credits we pay per delivered clip: one re-render in three on average (motion that collapses). */
const RETAKE = 1.3;

export function clipSecondsFor(onScreen: number): number {
  return Math.min(RUNWAY.maxClipSeconds, Math.max(RUNWAY.minClipSeconds, Math.round(onScreen) + 1));
}

export function priceRender(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const shots = Math.round(num(e.shots, 6, 0, MAX_SHOTS));
  const clip = clipSecondsFor(num(e.secondsPerShot, 3, 1, 14));
  const resolution = e.resolution === "720p" ? "720p" : "1080p";
  const fps60 = e.fps60 !== false;
  const music = e.music === "song" || e.music === "instrumental" ? e.music : "none";
  const takes = Math.round(num(e.musicTakes, 2, 1, 4));
  const usd = getConfig().pricing.runwayUsdPerCredit;
  const perSec = RUNWAY.videoCreditsPerSecond(resolution);
  const renderCredits = shots * clip * perSec * RETAKE;
  const fpsCredits = fps60 ? shots * Math.max(1, Math.ceil(clip * RUNWAY.enhanceCreditsPerSecond)) : 0;
  const musicCredits = music === "none" ? 0 : takes * RUNWAY.musicCredits(num(e.musicSeconds, 60, 5, 600), { song: music === "song" });
  return costPlus(
    "renderfarm",
    [
      ...(shots ? [{ item: `${shots} × ${clip} s ${resolution} clips on Runway (${perSec} credits/s, incl. retakes)`, usd: renderCredits * usd }] : []),
      ...(fps60 && shots ? [{ item: "60 fps frame-rate enhancement", usd: fpsCredits * usd }] : []),
      ...(music !== "none" ? [{ item: `${takes} ${music === "song" ? "song" : "instrumental"} take(s), Runway music`, usd: musicCredits * usd }] : []),
      llmLine("motion prompts", 3000 + 200 * shots, 800 + 150 * shots),
      gasLine(3),
    ],
    shots > 20 ? 2 : 1,
    opts,
  );
}

export async function planRender(job: Job): Promise<RenderSpec> {
  const e = job.estimate ?? {};
  const shots = Math.round(num(e.shots, Math.max(1, job.refs.length || 3), 0, MAX_SHOTS));
  const music = e.music === "song" || e.music === "instrumental" ? e.music : "none";
  const spec = await chatJson<RenderSpec>(
    [
      {
        role: "system",
        content:
          "You are RenderFarm, a video render agent. Turn the client's brief into a render list for Runway image-to-video. " +
          "Each prompt describes only the motion and the camera — the start frame fixes the look. Key action first, it must happen in the first 2 seconds. " +
          "Small, clear actions; no on-screen text. If the client gave images, use them as start frames in the order they appear.",
      },
      {
        role: "user",
        content:
          `Brief:\n${job.brief}\n\nClient images (in order):\n${job.refs.map((u, i) => `${i + 1}. ${u}`).join("\n") || "(none — text-to-video)"}\n\n` +
          `Render exactly ${shots} shot(s), aspect ${asAspect(e.aspect)}, ${e.resolution === "720p" ? "720p" : "1080p"}. ` +
          (music === "none" ? "No music." : `Also make ${music === "song" ? "a song with vocals (write the lyrics unless the brief has them; section tags in [brackets], never parentheses)" : "an instrumental track"} of about ${Math.round(num(e.musicSeconds, 60, 5, 600))} s.`) +
          `\nReply with JSON only: {"title": string, "aspect": "16:9"|"9:16"|"1:1", "resolution": "1080p"|"720p", "fps60": ${e.fps60 !== false}, ` +
          `"shots": [{"id": "s01", "seconds": number (on-screen length, 2-14), "prompt": "motion + camera", "image": "start frame URL from the list, or omit"}]` +
          (music === "none" ? "}" : `, "music": {"prompt": "genre, tempo, instruments, mood, vocal type", "lyrics": string, "instrumental": ${music !== "song"}, "seconds": number, "takes": ${Math.round(num(e.musicTakes, 2, 1, 4))}, "title": string}}`),
      },
    ],
    { tag: `render-plan:${job.id}`, maxTokens: 8000 },
  );
  spec.aspect = asAspect(spec.aspect ?? e.aspect);
  spec.resolution = spec.resolution === "720p" || e.resolution === "720p" ? "720p" : "1080p";
  spec.fps60 = e.fps60 !== false;
  spec.shots = (spec.shots ?? []).slice(0, shots);
  // The quote paid for shots × clip(secondsPerShot): never render more clip-seconds than that.
  if (e.secondsPerShot !== undefined) {
    const per = num(e.secondsPerShot, 3, 1, 14);
    const budget = spec.shots.length * clipSecondsFor(per);
    if (spec.shots.reduce((a, s) => a + clipSecondsFor(num(s.seconds, per, 1, 14)), 0) > budget) for (const s of spec.shots) s.seconds = per;
  }
  if (music === "none") spec.music = undefined;
  else if (spec.music) {
    spec.music.instrumental = music !== "song";
    if (spec.music.instrumental) spec.music.lyrics = "";
    spec.music.takes = Math.round(num(e.musicTakes, 2, 1, 4));
    spec.music.seconds = num(spec.music.seconds, num(e.musicSeconds, 60, 5, 600), 5, 600);
  }
  return spec;
}

/** Render every shot (image-to-video, or text-to-video without a start frame), enhance to 60 fps, package. */
export async function renderAll(job: Job, spec: RenderSpec): Promise<Deliverable> {
  const dir = path.join(job.dir, "work");
  const clipsDir = path.join(dir, "clips");
  const rawDir = path.join(dir, "raw");
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const usd = getConfig().pricing.runwayUsdPerCredit;

  await pool(spec.shots, 3, async (shot) => {
    const out = path.join(clipsDir, `${shot.id}.mp4`);
    if (fs.existsSync(out)) return;
    const seconds = clipSecondsFor(shot.seconds);
    const raw = path.join(rawDir, `${shot.id}.mp4`);
    let r: { url: string; credits?: number; taskId?: string } | undefined;
    for (let attempt = 1; attempt <= 2 && !r; attempt++) {
      try {
        r = shot.image
          ? await runwayImageToVideo({ image: shot.image, prompt: shot.prompt, seconds, aspect: spec.aspect, resolution: spec.resolution })
          : await runwayTextToVideo({ prompt: shot.prompt, seconds, aspect: spec.aspect, resolution: spec.resolution });
      } catch (err) {
        log.warn(`${job.id}: ${shot.id} render attempt ${attempt} failed: ${String(err).slice(0, 300)}`);
        if (attempt === 2) throw err;
      }
    }
    recordSpend(job, `render ${shot.id}`, (r!.credits ?? seconds * RUNWAY.videoCreditsPerSecond(spec.resolution)) * usd, r!.credits);
    await download(r!.url, raw);
    if (spec.fps60) {
      let e;
      try {
        e = await runwayEnhanceFps({ videoUrl: r!.url, taskId: r!.taskId, fps: 60, seconds });
      } catch (err) {
        log.warn(`${job.id}: ${shot.id} 60 fps by task id failed (${String(err).slice(0, 160)}), retrying by URL`);
        e = await runwayEnhanceFps({ videoUrl: r!.url, fps: 60, seconds });
      }
      recordSpend(job, `60fps ${shot.id}`, (e.credits ?? Math.ceil(seconds / 2)) * usd, e.credits);
      await download(e.url, out);
    } else {
      fs.copyFileSync(raw, out);
    }
  });

  const music: string[] = [];
  if (spec.music) {
    for (let k = 1; k <= spec.music.takes; k++) {
      const file = path.join(dir, `music-${k}.mp3`);
      if (!fs.existsSync(file)) {
        const m = await runwayMusic({ prompt: spec.music.prompt, seconds: spec.music.seconds, lyrics: spec.music.lyrics, instrumental: spec.music.instrumental, title: spec.music.title });
        recordSpend(job, `music take ${k}`, (m.credits ?? RUNWAY.musicCredits(spec.music.seconds, { song: !spec.music.instrumental })) * usd, m.credits);
        await download(m.url, file);
      }
      music.push(file);
    }
  }

  const probes = await Promise.all(spec.shots.map(async (s) => ({ id: s.id, ...(await probeVideo(path.join(clipsDir, `${s.id}.mp4`))) })));
  const manifest = {
    title: spec.title ?? "",
    aspect: spec.aspect,
    resolution: spec.resolution,
    fps: spec.fps60 ? 60 : undefined,
    shots: spec.shots.map((s) => ({ ...s, clip: `clips/${s.id}.mp4`, probe: probes.find((p) => p.id === s.id) })),
    music: music.length ? { ...spec.music, takes: music.map((f) => path.basename(f)) } : undefined,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const pack = await zip(path.join(job.dir, "clips.zip"), ["manifest.json", ...(spec.shots.length ? ["clips"] : []), ...music.map((f) => path.basename(f))], { cwd: dir });
  job.spec = spec;
  saveJob(job);
  const n = spec.shots.length;
  return {
    files: [
      { file: pack, contentType: "application/zip", label: "clips.zip" },
      { file: path.join(dir, "manifest.json"), contentType: "application/json", label: "manifest.json" },
      ...music.map((f) => ({ file: f, contentType: "audio/mpeg", label: path.basename(f) })),
    ],
    note:
      `${n} clip(s) rendered on Runway at ${spec.resolution} (${spec.aspect})${spec.fps60 ? ", enhanced to 60 fps" : ""}. clips.zip = clips/<shot id>.mp4 + manifest.json (prompts, durations).` +
      (music.length ? ` Music: ${music.length} ${spec.music!.instrumental ? "instrumental" : "song"} take(s) (${music.map((f) => path.basename(f)).join(", ")}).` : ""),
    summary: `✅ Delivered: ${n ? `${n} rendered clip(s) (${spec.resolution}, ${spec.aspect}${spec.fps60 ? ", 60 fps" : ""}) in clips.zip` : "the music"}${n && music.length ? " and " : ""}${n && music.length ? `${music.length} music take(s)` : ""}, with a manifest. Please review and accept on the order page; one redo is included.`,
  };
}

export const renderfarm: RoleSpec<RenderSpec> = {
  role: "renderfarm",
  name: "RenderFarm",
  persona: `You are RenderFarm, a video and music render agent on the Termix marketplace (agent.family), working on Runway.
- Image-to-video: one clip per start frame (your keyframes, or ours from Sketchboard), 3–15 s, 1080p or 720p, 16:9 / 9:16 / 1:1, driven by a short motion + camera prompt. Text-to-video when there is no start frame.
- Frame-rate enhancement to 60 fps (smooth motion for fast cuts and slow motion), optional.
- Music on Runway: a song with vocals (your lyrics or ours) or an instrumental bed, delivered as MP3 takes.
- Engine: ${RUNWAY.label}. Output: MP4 clips in clips.zip with a manifest; music as MP3.
- Turnaround: 1 day up to 20 shots, 2 days above. One redo per order.
Cannot do: editing a full film (Montage Studio does that), clips longer than 15 s per shot, readable text or logos in the video, lip-sync to a given voice, real people's likenesses, copyrighted characters or songs, 4K.
Pricing is per clip second from the Runway credits it uses (cost-plus). Ask how many shots, their on-screen length, the resolution, 60 fps or not, and whether they need music.`,
  estimateFields: `{"shots": integer 0-${MAX_SHOTS}, "secondsPerShot": number (on-screen length per shot, 1-14), "resolution": "1080p"|"720p", "fps60": boolean, "aspect": "16:9"|"9:16"|"1:1", "music": "none"|"song"|"instrumental", "musicSeconds": number, "musicTakes": integer 1-4}`,
  price: priceRender,
  async assess(job) {
    if (job.refs.length || job.brief.replace(/\s+/g, " ").trim().length >= 60) return { ok: true };
    return { ok: false, question: "Thanks for the order! Please send the start frames (images) for the shots, or describe each shot in a line or two, plus the format (16:9, 9:16 or 1:1). I start rendering as soon as I have them." };
  },
  async plan(job) {
    if (job.spec) return job.spec as RenderSpec;
    return planRender(job);
  },
  work: renderAll,
  estimateOf: (spec) => ({
    shots: spec.shots.length,
    secondsPerShot: spec.shots.length ? spec.shots.reduce((a, s) => a + s.seconds, 0) / spec.shots.length : 3,
    resolution: spec.resolution,
    fps60: spec.fps60,
    music: spec.music ? (spec.music.instrumental ? "instrumental" : "song") : "none",
    musicSeconds: spec.music?.seconds ?? 0,
    musicTakes: spec.music?.takes ?? 0,
  }),
  listing: {
    title: "Image-to-video shot renders + music on Runway, 1080p / 60 fps (RenderFarm)",
    skillTag: "image-to-video",
    tags: ["image-to-video", "runway", "ai-video", "animation", "render", "60fps", "music-video", "ai-music"],
    coverAlt: "Server racks turning a storyboard frame into a moving film strip",
    instantBuyable: true,
    description: `Video shots from your still frames (or prompts), rendered on Runway — plus music for them if you need it.

What you get
• One MP4 per shot, 3–15 s, 1080p or 720p, 16:9 / 9:16 / 1:1 (Kling 4 on Runway)
• Motion and camera driven by a short prompt per shot (we write it from your brief if you prefer)
• Optional 60 fps frame-rate enhancement
• Optional music: a song with vocals or an instrumental bed (Runway music, MP3 takes)
• clips.zip + manifest.json (prompts, durations)

Best with keyframes from a storyboard (see Sketchboard). Without images we render text-to-video.

How to order: buy a package and send the frames + one line per shot in chat, or message me for a quote — pricing is per clip second from the Runway credits used, cost-plus.

Not included: editing the clips into a film (see Montage Studio), on-screen text or logos, lip-sync to a given voice, real people's likenesses, copyrighted characters or songs, 4K.

Packages
{packages}

Turnaround: 1 day up to 20 shots, 2 days above. One redo per order.`,
    packages: [
      { id: "basic", name: "3 shots", scope: "3 image-to-video shots (~3 s on screen, 4 s clips), 1080p, 60 fps.", estimate: { shots: 3, secondsPerShot: 3, resolution: "1080p", fps60: true } },
      { id: "standard", name: "10 shots", scope: "10 image-to-video shots (~3 s on screen, 4 s clips), 1080p, 60 fps.", estimate: { shots: 10, secondsPerShot: 3, resolution: "1080p", fps60: true }, tone: "accent" },
      { id: "pro", name: "30 shots + song", scope: "A full music video's shots: 30 image-to-video shots (~3 s each), 1080p, 60 fps, plus 2 takes of a song with vocals.", estimate: { shots: 30, secondsPerShot: 3, resolution: "1080p", fps60: true, music: "song", musicSeconds: 120, musicTakes: 2 }, tone: "star" },
    ],
  },
};
