// ──────────────────────────────────────────────────────────
// Policy files, local state, and background workers
// ──────────────────────────────────────────────────────────
//
// The two autonomous loops in this skill (`aacp-autopilot.mjs` for taking work,
// `aacp-quant.mjs autotrade` for trading a client's session) need the same four
// things, and writing them twice guarantees they drift apart:
//
//   1. A POLICY file the user has read. Everything a loop is allowed to do is
//      in it. The loop never widens its own bounds — an out-of-policy decision
//      is refused and logged, not clamped into range, because a clamped value
//      is still a number the user never approved.
//   2. A STATE file. What has already been quoted, how much has been spent
//      today, the rolling price series. This is what makes a restart safe:
//      `POST /prepayment-orders/:id/offers` has NO server-side duplicate guard
//      (packages/backend/src/services/platform.ts), so the only thing standing
//      between a restart and a second quote on the same request is this file.
//   3. Per-day counters, so "max 5 offers a day" survives a restart at noon.
//   4. A single detached worker per scope, with an idempotent launcher.
//
// Zero dependencies, no side effects on import (house style for this skill).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── policy files ────────────────────────────────────────────────────────────

export function policyPath(file) {
  return resolve(process.cwd(), file);
}

export function policyExists(file) {
  return existsSync(policyPath(file));
}

/**
 * Read a policy file, or fail with the command that creates one.
 *
 * There is deliberately no "run with built-in defaults when the file is
 * missing" path: a loop that invents its own price band and daily cap is
 * exactly the thing the file exists to prevent.
 */
export function loadPolicy(file, { hint } = {}) {
  const path = policyPath(file);
  if (!existsSync(path)) {
    throw new Error(`No policy file at ${path}.${hint ? ` ${hint}` : ""}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed;
}

export function writePolicy(file, value) {
  const path = policyPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

// ── validation helpers ──────────────────────────────────────────────────────
//
// Every one of these returns a NUMBER or throws with the field name. A policy
// that half-parses is worse than one that is rejected: the loop would run on
// whatever `undefined` coerced to.

export function requireNumber(value, field, { min, max, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number (got ${JSON.stringify(value)}).`);
  if (integer && !Number.isInteger(n)) throw new Error(`${field} must be a whole number.`);
  if (min != null && n < min) throw new Error(`${field} must be at least ${min}.`);
  if (max != null && n > max) throw new Error(`${field} must be at most ${max}.`);
  return n;
}

export function requireText(value, field, { max = 10_000, min = 1 } = {}) {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min) throw new Error(`${field} is required.`);
  if (s.length > max) throw new Error(`${field} must be at most ${max} characters (got ${s.length}).`);
  return s;
}

export function requireOneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(value)}).`);
  return value;
}

export function requireStringArray(value, field, { max = 50, maxLength = 200 } = {}) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > max) throw new Error(`${field} may hold at most ${max} entries.`);
  return value.map((entry, i) => requireText(entry, `${field}[${i}]`, { max: maxLength }));
}

/** `true` when `text` contains any of `needles`, case-insensitively. */
export function matchesAny(text, needles) {
  if (!needles?.length) return false;
  const haystack = String(text ?? "").toLowerCase();
  return needles.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

// ── state ───────────────────────────────────────────────────────────────────

export function statePath(file) {
  return resolve(process.cwd(), file);
}

export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(file), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A missing or corrupt state file must not stop the loop from starting. It
    // costs at most a duplicate quote on one request, which the daily cap and
    // the operator's log both surface.
    return {};
  }
}

export function saveState(file, state) {
  try {
    writeFileSync(statePath(file), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** UTC day key. Counters roll at 00:00 UTC, the same boundary the platform uses. */
export function dayKey(at = new Date()) {
  return at.toISOString().slice(0, 10);
}

/**
 * Read a per-day counter, resetting it when the day rolled over.
 *
 * Kept separate from `bumpCounter` so a caller can check a cap BEFORE doing the
 * work it would count.
 */
export function counterFor(state, name, day = dayKey()) {
  const counters = state.counters ?? (state.counters = {});
  const row = counters[name];
  if (!row || row.day !== day) {
    counters[name] = { day, count: 0, amount: 0 };
  }
  return counters[name];
}

export function bumpCounter(state, name, { by = 1, amount = 0, day = dayKey() } = {}) {
  const row = counterFor(state, name, day);
  row.count += by;
  row.amount += amount;
  return row;
}

// ── background workers ──────────────────────────────────────────────────────
//
// Same shape as `a2a-runtime.mjs autoreply`: the plain foreground command IS
// the launcher. It self-detaches, so the host agent never needs permission to
// run something in the background, and re-running it while a worker is alive
// reports "already-online" instead of spawning a second one.
//
// (`a2a-runtime.mjs` keeps its own copy of this. It is a worker that has been
// running in the field for months; rewiring it through a new module would be
// churn with no user-visible gain.)

export function pidFilePath(scope) {
  return `/tmp/agent-mart-${scope}.pid`;
}

export function logFilePath(scope) {
  return `/tmp/agent-mart-${scope}.log`;
}

export function readPid(scope) {
  try {
    const n = Number(readFileSync(pidFilePath(scope), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePid(scope, pid) {
  try {
    writeFileSync(pidFilePath(scope), String(pid));
  } catch {
    /* best-effort */
  }
}

export function clearPid(scope) {
  try {
    writeFileSync(pidFilePath(scope), "");
  } catch {
    /* best-effort */
  }
}

export function workerStatus(scope) {
  const pid = readPid(scope);
  const online = Boolean(pid) && pidAlive(pid);
  return { scope, status: online ? "online" : "offline", pid: online ? pid : null, log: logFilePath(scope) };
}

export function stopWorker(scope) {
  const pid = readPid(scope);
  const wasAlive = Boolean(pid) && pidAlive(pid);
  if (wasAlive) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  clearPid(scope);
  return { scope, status: "offline", stoppedPid: wasAlive ? pid : null };
}
