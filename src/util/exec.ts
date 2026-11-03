import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Called with each stderr chunk as it arrives (progress lines, sign-page URLs, ...). */
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  input?: string;
}

/** Run a command without a shell, capturing output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Parse the last JSON object/array found in a string (scripts print progress lines before JSON). */
export function lastJson<T = unknown>(text: string): T | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  // Find the last top-level '{' or '[' that parses to the end.
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    // Walk back to the *start* of the JSON document: try progressively earlier openers.
    for (let j = i; j >= 0; j--) {
      const cj = trimmed[j];
      if (cj !== "{" && cj !== "[") continue;
      try {
        return JSON.parse(trimmed.slice(j)) as T;
      } catch {
        /* keep looking */
      }
    }
    break;
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
