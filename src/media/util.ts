import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { run } from "../util/exec.js";

/** Python for the media tools: the venv made by `npm run setup` (librosa) if present, else the system one. */
export function python(): string {
  const venv = path.join(getConfig().dataDir, "venv", "bin", "python");
  return process.env.PYTHON ?? (fs.existsSync(venv) ? venv : "python3");
}

export async function img(args: string[]): Promise<string> {
  const res = await run(python(), ["-I", path.join(getConfig().toolsDir, "img.py"), ...args], { timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`img.py ${args[0]} failed: ${res.stderr.slice(-400)}`);
  return res.stdout.trim();
}

/** zip -j: a flat archive of `files` (or `-r` of a directory when `dir` is given). */
export async function zip(out: string, files: string[], opts: { cwd?: string } = {}): Promise<string> {
  fs.rmSync(out, { force: true });
  const args = opts.cwd ? ["-q", "-r", out, ...files] : ["-q", "-j", out, ...files];
  const res = await run("zip", args, { cwd: opts.cwd, timeoutMs: 20 * 60_000 });
  if (res.code !== 0) throw new Error(`zip failed: ${res.stderr.slice(-400)}`);
  return out;
}

export async function download(url: string, dest: string, timeoutMs = 15 * 60_000): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + ".part", Buffer.from(await res.arrayBuffer()));
      fs.renameSync(dest + ".part", dest);
      return dest;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`download ${url.slice(0, 120)} failed: ${String(lastErr)}`);
}

/** Run `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

export const ASPECTS = {
  "16:9": { w: 1920, h: 1080, gen: "1536x1024" as const },
  "9:16": { w: 1080, h: 1920, gen: "1024x1536" as const },
  "1:1": { w: 1080, h: 1080, gen: "1024x1024" as const },
};
export type Aspect = keyof typeof ASPECTS;
export const asAspect = (v: unknown): Aspect => (v === "9:16" || v === "1:1" ? v : "16:9");
