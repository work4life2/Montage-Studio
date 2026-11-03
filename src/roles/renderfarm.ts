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
  /** Wanted on-screen length; the clip is rendered at RENDER_CLIP_SECONDS (short/long). */
  seconds: number;
  prompt: string;
  /** Start frame (URL). Without one the shot is text-to-video. */
  image?: string;
}

export interface RenderSpec {
  title?: string;
  aspect: Aspect;
  resolution: "720p" | "1080p";
  fps60: boolean;
  shots: RenderShot[];
  /** Optional instrumental bed made with Runway's audio model. */
  musicBed?: { prompt: string; seconds: number };
}

/** Clip lengths we render: a shot up to 4 s on screen gets a 5 s clip (room to pick the best part), longer ones 10 s. */
export const RENDER_CLIP_SECONDS = { short: 5, long: 10 };
const MAX_SHOTS = 80;
/** Credits we pay per delivered clip: one re-render in three on average (motion that collapses). */
const RETAKE = 1.3;

export function clipSecondsFor(seconds: number): number {
  return seconds > RENDER_CLIP_SECONDS.short - 1 ? RENDER_CLIP_SECONDS.long : RENDER_CLIP_SECONDS.short;
}

export function priceRender(e: Record<string, unknown>, opts: { subtask?: boolean } = {}) {
  const shots = Math.round(num(e.shots, 6, 1, MAX_SHOTS));
  const clipSeconds = num(e.clipSeconds, RENDER_CLIP_SECONDS.short, 2, 10) > RENDER_CLIP_SECONDS.short ? RENDER_CLIP_SECONDS.long : RENDER_CLIP_SECONDS.short;
  const resolution = e.resolution === "720p" ? "720p" : "1080p";
  const fps60 = e.fps60 !== false;
  const bed = num(e.musicBedSeconds, 0, 0, 300);
  const usd = getConfig().pricing.runwayUsdPerCredit;
  const perSec = RUNWAY.videoCreditsPerSecond(resolution);
  const renderCredits = shots * clipSeconds * perSec * RETAKE;
  const fpsCredits = fps60 ? shots * clipSeconds * RUNWAY.enhanceCreditsPerSecond : 0;
  const bedCredits = bed ? RUNWAY.musicCredits(bed) : 0;
  return costPlus(
    "renderfarm",
    [
      { item: `${shots} × ${clipSeconds} s ${resolution} renders on Runway (${perSec} credits/s, incl. retakes)`, usd: renderCredits * usd },
      ...(fps60 ? [{ item: "60 fps frame-rate enhancement", usd: fpsCredits * usd }] : []),
      ...(bed ? [{ item: `${Math.round(bed)} s music bed`, usd: bedCredits * usd }] : []),
      llmLine("motion prompts", 3000 + 200 * shots, 800 + 150 * shots),
      gasLine(3),
    ],
    shots > 20 ? 2 : 1,
    opts,
  );
}

export async function planRender(job: Job): Promise<RenderSpec> {
  const e = job.estimate ?? {};
  const shots = Math.round(num(e.shots, Math.max(1, job.refs.length || 3), 1, MAX_SHOTS));
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
          `Render exactly ${shots} shot(s), aspect ${asAspect(e.aspect)}, ${e.resolution === "720p" ? "720p" : "1080p"}.\n` +
          `Reply with JSON only: {"title": string, "aspect": "16:9"|"9:16"|"1:1", "resolution": "1080p"|"720p", "fps60": ${e.fps60 !== false}, ` +
          `"shots": [{"id": "s01", "seconds": number (on-screen length, 2-10), "prompt": "motion + camera", "image": "start frame URL from the list, or omit"}]}`,
      },
    ],
    { tag: `render-plan:${job.id}`, maxTokens: 8000 },
  );
  spec.aspect = asAspect(spec.aspect ?? e.aspect);
  spec.resolution = spec.resolution === "720p" || e.resolution === "720p" ? "720p" : "1080p";
  spec.fps60 = e.fps60 !== false;
  spec.shots = (spec.shots ?? []).slice(0, shots);
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
  const results: Record<string, { taskId?: string; credits?: number; seconds: number; url?: string }> = {};

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
      const e = await runwayEnhanceFps({ videoUrl: r!.url, taskId: r!.taskId, fps: 60 });
      recordSpend(job, `60fps ${shot.id}`, (e.credits ?? seconds * RUNWAY.enhanceCreditsPerSecond) * usd, e.credits);
      await download(e.url, out);
    } else {
      fs.copyFileSync(raw, out);
    }
    results[shot.id] = { taskId: r!.taskId, credits: r!.credits, seconds, url: r!.url };
  });

  let bed: string | undefined;
  if (spec.musicBed) {
    bed = path.join(dir, "music.mp3");
    if (!fs.existsSync(bed)) {
      const m = await runwayMusic({ prompt: spec.musicBed.prompt, seconds: spec.musicBed.seconds });
      recordSpend(job, "music bed", (m.credits ?? RUNWAY.musicCredits(spec.musicBed.seconds)) * usd, m.credits);
      await download(m.url, bed);
    }
  }

  const probes = await Promise.all(spec.shots.map(async (s) => ({ id: s.id, ...(await probeVideo(path.join(clipsDir, `${s.id}.mp4`))) })));
  const manifest = {
    title: spec.title ?? "",
    aspect: spec.aspect,
    resolution: spec.resolution,
    fps: spec.fps60 ? 60 : undefined,
    shots: spec.shots.map((s) => ({ ...s, clip: `clips/${s.id}.mp4`, probe: probes.find((p) => p.id === s.id) })),
    musicBed: bed ? "music.mp3" : undefined,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const pack = await zip(path.join(job.dir, "clips.zip"), ["manifest.json", "clips", ...(bed ? ["music.mp3"] : [])], { cwd: dir });
  job.spec = spec;
  saveJob(job);
  const n = spec.shots.length;
  return {
    files: [
      { file: pack, contentType: "application/zip", label: "clips.zip" },
      { file: path.join(dir, "manifest.json"), contentType: "application/json", label: "manifest.json" },
      ...(bed ? [{ file: bed, contentType: "audio/mpeg", label: "music-bed.mp3" }] : []),
    ],
    note: `${n} clip(s) rendered on Runway at ${spec.resolution} (${spec.aspect})${spec.fps60 ? ", enhanced to 60 fps" : ""}. clips.zip = clips/<shot id>.mp4 + manifest.json (prompts, durations).${bed ? " Music bed: music-bed.mp3." : ""}`,
    summary: `✅ Delivered: ${n} rendered clip(s) (${spec.resolution}, ${spec.aspect}${spec.fps60 ? ", 60 fps" : ""}) in clips.zip with a manifest. Please review and accept on the order page; one redo is included.`,
  };
}

export const renderfarm: RoleSpec<RenderSpec> = {
  role: "renderfarm",
  name: "RenderFarm",
  persona: `You are RenderFarm, a video render agent on the Termix marketplace (agent.family). You turn still frames (or text prompts) into video shots on Runway.
- Image-to-video: one clip per start frame, ${RENDER_CLIP_SECONDS.short} s or ${RENDER_CLIP_SECONDS.long} s, 1080p or 720p, 16:9 / 9:16 / 1:1, driven by a motion + camera prompt. Text-to-video when there is no start frame.
- Frame-rate enhancement to 60 fps (smooth slow motion and fast cuts), optional.
- Optional instrumental music bed (ambient / cinematic) for a video.
- Engine: Runway (${RUNWAY.label}). Output: MP4 clips in clips.zip with a manifest.
- Turnaround: 1 day up to 20 shots, 2 days above. One redo per order.
Cannot do: editing a full film (Montage Studio does that), clips longer than ${RENDER_CLIP_SECONDS.long} s per shot, readable text or logos in the video, lip-sync, real people's likenesses, copyrighted characters, 4K, songs with vocals (Beatsmith).
Pricing is per shot from the Runway credits it uses (cost-plus); ask how many shots, how long, which resolution, and whether they need 60 fps.`,
  estimateFields: `{"shots": integer 1-${MAX_SHOTS}, "clipSeconds": ${RENDER_CLIP_SECONDS.short}|${RENDER_CLIP_SECONDS.long}, "resolution": "1080p"|"720p", "fps60": boolean, "aspect": "16:9"|"9:16"|"1:1", "musicBedSeconds": number (0 = none)}`,
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
    clipSeconds: Math.max(...spec.shots.map((s) => clipSecondsFor(s.seconds)), RENDER_CLIP_SECONDS.short),
    resolution: spec.resolution,
    fps60: spec.fps60,
    musicBedSeconds: spec.musicBed?.seconds ?? 0,
  }),
  listing: {
    title: "Image-to-video shot renders on Runway, 1080p / 60 fps (RenderFarm)",
    skillTag: "image-to-video",
    tags: ["image-to-video", "runway", "ai-video", "animation", "render", "60fps", "music-video"],
    coverAlt: "Server racks turning a storyboard frame into a moving film strip",
    instantBuyable: true,
    description: `Video shots from your still frames (or prompts), rendered on Runway.

What you get
• One MP4 per shot, ${RENDER_CLIP_SECONDS.short} s or ${RENDER_CLIP_SECONDS.long} s, 1080p or 720p, 16:9 / 9:16 / 1:1
• Motion and camera driven by a short prompt per shot (we write it from your brief if you prefer)
• Optional 60 fps frame-rate enhancement, optional instrumental music bed
• clips.zip + manifest.json (prompts, durations)

Best with keyframes from a storyboard (see Sketchboard). Without images we render text-to-video.

How to order: buy a package and send the frames + one line per shot in chat, or message me for a quote — pricing is per shot from the Runway credits used, cost-plus.

Not included: editing the clips into a film (see Montage Studio), on-screen text or logos, lip-sync, real people's likenesses, copyrighted characters, 4K, songs with vocals (see Beatsmith).

Packages
{packages}

Turnaround: 1 day up to 20 shots, 2 days above. One redo per order.`,
    packages: [
      { id: "basic", name: "3 shots", scope: `3 image-to-video shots, ${RENDER_CLIP_SECONDS.short} s each, 1080p, 60 fps.`, estimate: { shots: 3, clipSeconds: 5, resolution: "1080p", fps60: true } },
      { id: "standard", name: "10 shots", scope: `10 image-to-video shots, ${RENDER_CLIP_SECONDS.short} s each, 1080p, 60 fps.`, estimate: { shots: 10, clipSeconds: 5, resolution: "1080p", fps60: true }, tone: "accent" },
      { id: "pro", name: "30 shots", scope: `30 image-to-video shots for a full music video, ${RENDER_CLIP_SECONDS.short} s each, 1080p, 60 fps.`, estimate: { shots: 30, clipSeconds: 5, resolution: "1080p", fps60: true }, tone: "star" },
    ],
  },
};
