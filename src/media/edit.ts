import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";
import { python, type Aspect } from "./util.js";

const log = logger("edit");

export interface Beats {
  tempo: number;
  duration: number;
  beats: number[];
  downbeats: number[];
  method?: string;
}

export interface EditShot {
  id: string;
  clip: string;
  /** Planned length in seconds (scaled to fit the song). */
  seconds: number;
  /** Optional on-screen text for this shot (lower third). */
  caption?: string;
}

export interface EditInput {
  workDir: string;
  aspect: Aspect;
  resolution: "720p" | "1080p";
  fps: 24 | 30 | 60;
  shots: EditShot[];
  audio?: string;
  /** Wanted length; defaults to the sum of the shot lengths (capped by the song). */
  targetSec?: number;
  /** Where in the song to start (seconds). */
  audioStart?: number;
  titleText?: string;
  endText?: string;
  outName: string;
}

export interface CutEntry {
  id: string;
  start: number;
  end: number;
  speed: number;
}

export interface EditResult {
  master: string;
  preview: string;
  cutlist: CutEntry[];
  durationSec: number;
  tempo?: number;
}

function dims(aspect: Aspect, res: "720p" | "1080p"): { w: number; h: number } {
  const short = res === "720p" ? 720 : 1080;
  const long = res === "720p" ? 1280 : 1920;
  if (aspect === "9:16") return { w: short, h: long };
  if (aspect === "1:1") return { w: short, h: short };
  return { w: long, h: short };
}

async function ff(args: string[], timeoutMs = 30 * 60_000): Promise<void> {
  const res = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeoutMs });
  if (res.code !== 0) throw new Error(`ffmpeg failed: ${res.stderr.slice(-800)}`);
}

export async function probeDuration(file: string): Promise<number> {
  const res = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeoutMs: 60_000 });
  const d = Number(res.stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe: no duration for ${file}: ${res.stderr.slice(-200)}`);
  return d;
}

export async function probeVideo(file: string): Promise<{ width: number; height: number; fps: number; duration: number }> {
  const res = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], { timeoutMs: 60_000 });
  const j = JSON.parse(res.stdout || "{}") as { streams?: Array<{ width: number; height: number; r_frame_rate: string }>; format?: { duration?: string } };
  const s = j.streams?.[0];
  if (!s) throw new Error(`ffprobe: no video stream in ${file}`);
  const [n, d] = s.r_frame_rate.split("/").map(Number);
  return { width: s.width, height: s.height, fps: d ? n / d : n, duration: Number(j.format?.duration ?? 0) };
}

export async function analyzeBeats(audio: string): Promise<Beats> {
  const res = await run(python(), ["-I", path.join(getConfig().toolsDir, "beats.py"), audio], { timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error(`beats.py failed: ${res.stderr.slice(-400)}`);
  return JSON.parse(res.stdout) as Beats;
}

/** A bold sans font for titles: FONT_FILE, else the first that exists. */
function fontFile(): string {
  const candidates = [
    process.env.FONT_FILE,
    "/usr/share/fonts/truetype/inter/Inter-Black.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Black.otf",
    "/usr/share/fonts/truetype/noto/NotoSans-Black.ttf",
    "/usr/share/fonts/google-noto/NotoSans-Black.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
  ].filter((x): x is string => Boolean(x));
  const hit = candidates.find((f) => fs.existsSync(f));
  if (!hit) throw new Error("no font for titles: install fonts-dejavu-core or set FONT_FILE");
  return hit;
}

/** ffmpeg filter-graph escaping for a file path used inside an option value. */
const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/**
 * Cut points: the planned shot lengths scaled to the target, each interior boundary snapped to the
 * nearest beat (downbeats preferred) when one is close, never leaving a shot shorter than 0.8 s.
 */
export function cutPoints(lengths: number[], total: number, beats?: Beats): number[] {
  const sum = lengths.reduce((a, b) => a + b, 0) || 1;
  const bounds = [0];
  for (const l of lengths) bounds.push(bounds[bounds.length - 1] + (l / sum) * total);
  bounds[bounds.length - 1] = total;
  if (!beats?.beats.length) return bounds;
  const down = new Set(beats.downbeats.map((b) => b.toFixed(3)));
  for (let i = 1; i < bounds.length - 1; i++) {
    const want = bounds[i];
    const shot = Math.min(bounds[i] - bounds[i - 1], (bounds[i + 1] ?? total) - bounds[i]);
    const reach = Math.max(0.15, Math.min(0.6, shot * 0.35));
    let best: number | undefined;
    let bestScore = Infinity;
    for (const b of beats.beats) {
      const d = Math.abs(b - want);
      if (d > reach) continue;
      const score = d - (down.has(b.toFixed(3)) ? reach * 0.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best !== undefined && best - bounds[i - 1] >= 0.8 && bounds[i + 1] - best >= 0.8) bounds[i] = best;
  }
  return bounds;
}

/**
 * Beat-synced edit: each shot's clip is trimmed (or slowed, then held) to its slot, scaled to the
 * frame, titles burnt in, cut on the beat, laid over the song (faded, loudness-normalised to -14 LUFS),
 * then encoded as an H.264 master plus a light preview.
 */
export async function editToBeat(input: EditInput): Promise<EditResult> {
  const { w, h } = dims(input.aspect, input.resolution);
  const fps = input.fps;
  const seg = path.join(input.workDir, "segments");
  fs.mkdirSync(seg, { recursive: true });
  const font = fontFile();

  let beats: Beats | undefined;
  let audioDur = Infinity;
  if (input.audio) {
    beats = await analyzeBeats(input.audio);
    audioDur = beats.duration - (input.audioStart ?? 0);
    const start = input.audioStart ?? 0;
    // Work in timeline time: shift the grid so 0 = where the song starts in the edit.
    beats = { ...beats, beats: beats.beats.map((b) => b - start).filter((b) => b > 0), downbeats: beats.downbeats.map((b) => b - start).filter((b) => b > 0) };
  }
  const planned = input.shots.reduce((a, s) => a + s.seconds, 0);
  let total = Math.min(input.targetSec ?? planned, audioDur);
  // End on a downbeat when one is near, so the music fade lands on the bar.
  if (beats?.downbeats.length) {
    const near = beats.downbeats.filter((b) => Math.abs(b - total) <= 2).sort((a, b) => Math.abs(a - total) - Math.abs(b - total))[0];
    if (near && near > 2) total = near;
  }
  const bounds = cutPoints(
    input.shots.map((s) => s.seconds),
    total,
    beats,
  );
  // Snap every boundary to the frame grid so the concat has no drift.
  const frameAt = (t: number) => Math.round(t * fps);
  const cutlist: CutEntry[] = [];
  const parts: string[] = [];
  for (const [i, shot] of input.shots.entries()) {
    const f0 = frameAt(bounds[i]);
    const f1 = frameAt(bounds[i + 1]);
    const frames = Math.max(1, f1 - f0);
    const L = frames / fps;
    const D = await probeDuration(shot.clip);
    const speed = D >= L ? 1 : Math.max(0.5, D / L);
    const filters = [
      speed < 1 ? `setpts=PTS/${speed.toFixed(4)}` : "setpts=PTS-STARTPTS",
      `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${w}:${h}`,
      `fps=${fps}`,
      `tpad=stop_mode=clone:stop_duration=${(L + 1).toFixed(2)}`,
      "format=yuv420p",
    ];
    const text = (file: string, body: string) => {
      fs.writeFileSync(file, body);
      return esc(file);
    };
    if (i === 0 && input.titleText) {
      const tf = text(path.join(seg, `${shot.id}-title.txt`), input.titleText);
      filters.push(
        `drawtext=fontfile='${esc(font)}':textfile='${tf}':fontcolor=white:fontsize=${Math.round(Math.min(w, h) * 0.1)}:x=(w-text_w)/2:y=(h-text_h)/2:` +
          `shadowcolor=black@0.55:shadowx=5:shadowy=5:alpha='if(lt(t,0.2),0,if(lt(t,0.5),(t-0.2)/0.3,if(lt(t,${Math.max(1, L - 0.4).toFixed(2)}),1,max(0,(${L.toFixed(2)}-t)/0.4))))'`,
      );
    }
    if (shot.caption) {
      const tf = text(path.join(seg, `${shot.id}-caption.txt`), shot.caption);
      filters.push(
        `drawtext=fontfile='${esc(font)}':textfile='${tf}':fontcolor=white:fontsize=${Math.round(Math.min(w, h) * 0.045)}:x=(w-text_w)/2:y=h-text_h-${Math.round(h * 0.08)}:` +
          `box=1:boxcolor=black@0.45:boxborderw=${Math.round(h * 0.015)}`,
      );
    }
    if (i === input.shots.length - 1 && input.endText) {
      const tf = text(path.join(seg, `${shot.id}-end.txt`), input.endText);
      const from = Math.max(0, L - 2.6);
      filters.push(
        `drawtext=fontfile='${esc(font)}':textfile='${tf}':fontcolor=white:fontsize=${Math.round(Math.min(w, h) * 0.075)}:x=(w-text_w)/2:y=(h-text_h)/2:` +
          `shadowcolor=black@0.55:shadowx=4:shadowy=4:enable='gte(t,${from.toFixed(2)})':alpha='min(1,(t-${from.toFixed(2)})/0.4)'`,
      );
    }
    const out = path.join(seg, `${String(i).padStart(3, "0")}-${shot.id}.mp4`);
    await ff(["-i", shot.clip, "-an", "-vf", filters.join(","), "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-r", String(fps), out]);
    parts.push(out);
    cutlist.push({ id: shot.id, start: f0 / fps, end: f1 / fps, speed: Math.round(speed * 1000) / 1000 });
  }
  const list = path.join(seg, "concat.txt");
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const video = path.join(input.workDir, "video.mp4");
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
  const duration = frameAt(total) / fps;

  const master = path.join(input.workDir, `${input.outName}.mp4`);
  const enc = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  if (input.audio) {
    const fade = Math.min(2, duration / 4);
    await ff([
      "-i", video,
      "-ss", String(input.audioStart ?? 0), "-t", duration.toFixed(3), "-i", input.audio,
      "-filter_complex", `[1:a]afade=t=in:st=0:d=0.05,afade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade.toFixed(3)},loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[a]`,
      "-map", "0:v", "-map", "[a]", ...enc, "-c:a", "aac", "-b:a", "256k", "-shortest", master,
    ]);
  } else {
    await ff(["-i", video, ...enc, "-an", master]);
  }
  const preview = path.join(input.workDir, `${input.outName}-preview-720p.mp4`);
  const pw = w >= h ? 1280 : 720;
  await ff(["-i", master, "-vf", `scale=${pw}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", preview]);
  log.info(`edit done: ${input.shots.length} shots, ${duration.toFixed(2)} s, ${w}x${h}@${fps}${beats ? `, ${beats.tempo} BPM (${beats.method})` : ""}`);
  return { master, preview, cutlist, durationSec: duration, tempo: beats?.tempo };
}
