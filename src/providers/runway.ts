import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { jsonOf, mcp, textOf, type McpCallResult } from "../mcp/client.js";
import type { Aspect } from "../media/util.js";
import { sleep } from "../util/exec.js";

const log = logger("runway");

/**
 * Runway through its hosted MCP server (the user's account, OAuth). Rates are the ones the MCP's own
 * tool descriptions state (2026-11): kling-4 15.7 credits/s at 720p, 23.5 at 1080p (audio always on,
 * 3-30 s); Enhance Frame Rate 1 credit per 2 s; lyria-3-pro 8 credits per song, lyria-3-clip 4.
 */
export const VIDEO_MODEL = process.env.RUNWAY_VIDEO_MODEL ?? "kling-4";
export const RUNWAY = {
  label: "Runway (Kling 4 video, Lyria 3 music)",
  videoCreditsPerSecond: (res: "720p" | "1080p") => (res === "720p" ? 15.7 : 23.5),
  enhanceCreditsPerSecond: 0.5,
  minClipSeconds: 3,
  maxClipSeconds: 15,
  /** Lyria 3 Pro (full track) 8, Lyria 3 Clip (≤ 30 s) 4, Eleven Music ceil(s × 196 / 600). */
  musicCredits: (seconds: number, opts: { song?: boolean; engine?: MusicEngine } = {}) =>
    opts.engine === "eleven" ? Math.max(1, Math.ceil((seconds * 196) / 600)) : opts.song || seconds > 30 ? 8 : 4,
};

/** lyria = Google Lyria 3 (Pro for full tracks, Clip for short beds); eleven = ElevenLabs Eleven Music (exact length). */
export type MusicEngine = "lyria" | "eleven";

export interface RunwayResult {
  url: string;
  credits?: number;
  taskId?: string;
}

/**
 * Task bookkeeping for one job: a task id is recorded the moment Runway accepts it, so a restart
 * polls the task it already paid for instead of submitting (and paying for) it again.
 */
export interface TaskLedger {
  get(key: string): string | undefined;
  set(key: string, taskId: string): void;
}

async function startOrResume(ledger: TaskLedger | undefined, key: string | undefined, start: () => Promise<string>): Promise<string> {
  const known = ledger && key ? ledger.get(key) : undefined;
  if (known) {
    log.info(`resuming Runway task ${known} (${key})`);
    return known;
  }
  const id = await start();
  if (ledger && key) ledger.set(key, id);
  return id;
}

const RATIONALE = "Montage Studio's RenderFarm agent: rendering a paid client order on the Termix marketplace";

function rawLog(tool: string, r: McpCallResult) {
  try {
    const dir = path.join(getConfig().dataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "runway-mcp.jsonl"), JSON.stringify({ at: new Date().toISOString(), tool, result: r }).slice(0, 20_000) + "\n");
  } catch {
    /* best effort */
  }
}

async function call(tool: string, args: Record<string, unknown>): Promise<{ r: McpCallResult; json: Record<string, unknown>; text: string }> {
  const r = await mcp("runway").call(tool, { rationale: RATIONALE, ...args });
  rawLog(tool, r);
  return { r, json: jsonOf<Record<string, unknown>>(r) ?? {}, text: textOf(r) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function taskIdOf(json: Record<string, unknown>, text: string): string {
  const t = (json.taskId ?? json.id ?? (json.task as { id?: string } | undefined)?.id) as string | undefined;
  if (t) return t;
  const m = /task[ _-]?id\W{0,4}([0-9a-f-]{36})/i.exec(text) ?? UUID.exec(text);
  if (!m) throw new Error(`no task id in Runway response: ${text.slice(0, 300)}`);
  return m[1] ?? m[0];
}

function find<T>(obj: unknown, pick: (k: string, v: unknown) => T | undefined, depth = 0): T | undefined {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const hit = pick(k, v);
    if (hit !== undefined) return hit;
    const deeper = find(v, pick, depth + 1);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** Poll get_task until the task finished; returns the first output asset URL. */
async function waitTask(taskId: string, kind: "video" | "audio", timeoutMs = 30 * 60_000): Promise<RunwayResult> {
  const end = Date.now() + timeoutMs;
  let wait = kind === "video" ? 45_000 : 20_000;
  while (Date.now() < end) {
    await sleep(wait);
    wait = Math.min(90_000, wait + 15_000);
    let res;
    try {
      res = await call("get_task", { id: taskId });
    } catch (err) {
      log.warn(`get_task ${taskId}: ${String(err).slice(0, 200)}`);
      continue;
    }
    const status = String(res.json.status ?? find(res.json, (k, v) => (k === "status" && typeof v === "string" ? v : undefined)) ?? /status\W{0,4}([A-Z_]+)/.exec(res.text)?.[1] ?? "").toUpperCase();
    if (["FAILED", "CANCELLED", "CANCELED", "ABORTED"].includes(status)) throw new Error(`Runway task ${taskId} ${status}: ${(res.json.failure as string) ?? res.text.slice(0, 300)}`);
    if (status !== "SUCCEEDED" && status !== "COMPLETED") continue;
    const ext = kind === "video" ? /\.(mp4|mov|webm)(\?|$)/i : /\.(mp3|wav|m4a|aac)(\?|$)/i;
    const url =
      find(res.json, (_k, v) => (typeof v === "string" && /^https:\/\//.test(v) && ext.test(v) ? v : undefined)) ??
      [...res.text.matchAll(/https:\/\/[^\s)"'\]]+/g)].map((m) => m[0]).find((u) => ext.test(u));
    if (!url) throw new Error(`Runway task ${taskId} succeeded but carries no ${kind} URL: ${res.text.slice(0, 300)}`);
    const credits = find(res.json, (k, v) => (/credit/i.test(k) && typeof v === "number" ? v : undefined));
    return { url, taskId, credits };
  }
  throw new Error(`Runway task ${taskId} did not finish in ${Math.round(timeoutMs / 60_000)} min`);
}

/** A local file becomes a Runway-hosted asset (init_upload → PUT → complete_upload); URLs pass through. */
export async function runwayAsset(src: string): Promise<string> {
  if (/^https:\/\//.test(src)) return src;
  const size = fs.statSync(src).size;
  const ext = path.extname(src).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".mp4" ? "video/mp4" : ext === ".wav" ? "audio/wav" : "audio/mpeg";
  const init = await call("init_upload", { filename: path.basename(src), fileSize: size, mimeType });
  const urls = (init.json.uploadUrls as string[] | undefined) ?? [];
  if (!init.json.uploadId || urls.length !== 1) throw new Error(`init_upload: unexpected response (${urls.length} part URLs)`);
  const put = await fetch(urls[0], { method: "PUT", body: fs.readFileSync(src), signal: AbortSignal.timeout(10 * 60_000) });
  if (!put.ok) throw new Error(`Runway upload PUT HTTP ${put.status}`);
  const etag = (put.headers.get("etag") ?? "").replace(/"/g, "");
  const done = await call("complete_upload", { uploadId: init.json.uploadId, parts: [{ partNumber: 1, etag }] });
  const url = (done.json.assetUrl ?? done.json.url) as string | undefined;
  if (!url) throw new Error(`complete_upload returned no asset URL: ${done.text.slice(0, 300)}`);
  return url;
}

function clipLength(seconds: number): number {
  return Math.min(RUNWAY.maxClipSeconds, Math.max(RUNWAY.minClipSeconds, Math.round(seconds)));
}

export async function runwayImageToVideo(i: { image: string; prompt: string; seconds: number; aspect: Aspect; resolution: "720p" | "1080p"; ledger?: TaskLedger; key?: string }): Promise<RunwayResult> {
  const duration = clipLength(i.seconds);
  const taskId = await startOrResume(i.ledger, i.key, async () => {
    const url = await runwayAsset(i.image);
    const start = await call("generate_video", { model: VIDEO_MODEL, promptText: i.prompt.slice(0, 3400), startFrame: { url }, ratio: i.aspect, duration, resolution: i.resolution });
    const id = taskIdOf(start.json, start.text);
    log.info(`i2v task ${id} (${VIDEO_MODEL}, ${duration}s ${i.resolution})`);
    return id;
  });
  const r = await waitTask(taskId, "video");
  return { ...r, credits: r.credits ?? duration * RUNWAY.videoCreditsPerSecond(i.resolution) };
}

export async function runwayTextToVideo(i: { prompt: string; seconds: number; aspect: Aspect; resolution: "720p" | "1080p"; ledger?: TaskLedger; key?: string }): Promise<RunwayResult> {
  const duration = clipLength(i.seconds);
  const taskId = await startOrResume(i.ledger, i.key, async () => {
    const start = await call("generate_video", { model: VIDEO_MODEL, promptText: i.prompt.slice(0, 3400), ratio: i.aspect, duration, resolution: i.resolution });
    const id = taskIdOf(start.json, start.text);
    log.info(`t2v task ${id} (${VIDEO_MODEL}, ${duration}s ${i.resolution})`);
    return id;
  });
  const r = await waitTask(taskId, "video");
  return { ...r, credits: r.credits ?? duration * RUNWAY.videoCreditsPerSecond(i.resolution) };
}

export async function runwayEnhanceFps(i: { videoUrl: string; taskId?: string; fps: number; seconds: number; ledger?: TaskLedger; key?: string }): Promise<RunwayResult> {
  const video = i.taskId ? { taskId: i.taskId } : { url: i.videoUrl, durationSeconds: i.seconds };
  const taskId = await startOrResume(i.ledger, i.key, async () => {
    const start = await call("enhance_frame_rate", { video, targetFrameRate: String(i.fps) });
    return taskIdOf(start.json, start.text);
  });
  const r = await waitTask(taskId, "video");
  return { ...r, credits: r.credits ?? Math.max(1, Math.ceil(i.seconds / 2)) };
}

/**
 * Music: a song with vocals (lyrics in the prompt) or an instrumental. Lyria 3 Pro for full tracks,
 * Lyria 3 Clip for short beds; Eleven Music when the length must be exact (3–600 s).
 */
export async function runwayMusic(i: { prompt: string; seconds: number; lyrics?: string; instrumental?: boolean; title?: string; engine?: MusicEngine; ledger?: TaskLedger; key?: string }): Promise<RunwayResult> {
  const song = Boolean(i.lyrics && !i.instrumental);
  const eleven = i.engine === "eleven";
  const seconds = Math.min(600, Math.max(3, Math.round(i.seconds)));
  const model = eleven ? "eleven-music-v2.5" : song || i.seconds > 30 ? "lyria-3-pro" : "lyria-3-clip";
  const promptText = [i.prompt, song ? `Lyrics:\n${i.lyrics}` : "Instrumental, no vocals.", eleven ? "" : `Length: at least ${seconds} seconds.`].filter(Boolean).join("\n\n").slice(0, 5000);
  const extra = eleven ? { durationSeconds: seconds, ...(song ? {} : { forceInstrumental: true }) } : {};
  const taskId = await startOrResume(i.ledger, i.key, async () => {
    const start = await call("generate_music", { promptText, model, ...extra, ...(i.title ? { name: i.title.slice(0, 200) } : {}), confirmRepeat: true });
    const id = taskIdOf(start.json, start.text);
    log.info(`music task ${id} (${model})`);
    return id;
  });
  const r = await waitTask(taskId, "audio", 15 * 60_000);
  return { ...r, credits: r.credits ?? RUNWAY.musicCredits(seconds, { song, engine: i.engine }) };
}

/** Remaining credits of the connected workspace (whoami). */
export async function runwayCredits(): Promise<number | undefined> {
  const r = await call("whoami", {});
  const c = r.json.credits as { total?: number } | undefined;
  return c?.total;
}
