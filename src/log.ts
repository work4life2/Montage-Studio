import fs from "node:fs";
import path from "node:path";

let logFile: string | undefined;

export function initLogFile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, "agent.log");
}

function write(level: string, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + safeJson(extra);
  const line = `${ts} [${level}] [${scope}] ${msg}${tail}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      /* ignore */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => write("INFO", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write("WARN", scope, msg, extra),
    error: (msg: string, extra?: unknown) => write("ERROR", scope, msg, extra),
    debug: (msg: string, extra?: unknown) => {
      if (process.env.DEBUG) write("DEBUG", scope, msg, extra);
    },
  };
}

export type Logger = ReturnType<typeof logger>;
