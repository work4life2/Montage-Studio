#!/usr/bin/env node
//
// Skill update check + self-update — pull-based, from the public release manifest.
//
// Every release publishes two objects to the platform bucket at fixed keys:
//
//   .../platform/agent-skills/termix-agent.skill         the zip bundle
//   .../platform/agent-skills/termix-agent.release.json  the release manifest
//
// The manifest is plain public JSON:
//   { "package", "version", "publishedAt", "download", "sha256", "sizeBytes", "notes"? }
//
// This script GETs the manifest (no login, no session, no platform API) and
// compares `version` against the local VERSION file (stamped at build time, next
// to SKILL.md). `apply` then downloads `download`, verifies `sha256`, and
// replaces the installed skill directory in place.
//
// Usage:
//   node aacp-update.mjs check        (default) print a JSON status object
//   node aacp-update.mjs apply        download + verify + replace this skill dir
//
// Env: TERMIX_SKILL_MANIFEST_URL (overrides the manifest URL, e.g. for staging).
//
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const DEFAULT_MANIFEST_URL =
  "https://termix-aacp-avatar.s3.ap-southeast-1.amazonaws.com/platform/agent-skills/termix-agent.release.json";
const SKILL_PACKAGE = "termix-agent-skills";
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Path prefix of the skill payload inside the release zip.
const ZIP_SKILL_PREFIX = `skills/${SKILL_PACKAGE}/`;

function manifestUrl() {
  return (process.env.TERMIX_SKILL_MANIFEST_URL ?? DEFAULT_MANIFEST_URL).trim();
}

// Installed version = the VERSION file at the skill root (sibling of SKILL.md),
// stamped from package.json by build-release.mjs. Missing → dev checkout.
export function readInstalledVersion() {
  const path = join(SKILL_DIR, "VERSION");
  if (!existsSync(path)) return null;
  const v = readFileSync(path, "utf8").trim();
  return v || null;
}

// Numeric segment compare ("1.10.0" > "1.9.1"). Non-numeric segments compare
// as strings; returns null when either side is missing/unparsable.
function compareVersions(a, b) {
  if (!a || !b) return null;
  const as = String(a).split(".");
  const bs = String(b).split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const ax = as[i] ?? "0";
    const bx = bs[i] ?? "0";
    const an = Number(ax);
    const bn = Number(bx);
    const cmp = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : ax.localeCompare(bx);
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }
  return 0;
}

async function fetchManifest(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const manifest = await res.json();
  if (!manifest || typeof manifest.version !== "string") {
    throw new Error(`manifest at ${url} has no \`version\` field`);
  }
  return manifest;
}

// Core check, importable by other scripts (a2a-runtime.mjs autoreply worker).
// Needs no credentials — the manifest is a public object.
export async function checkForUpdate({ installedVersion, url } = {}) {
  const installed = installedVersion !== undefined ? installedVersion : readInstalledVersion();
  const src = url ?? manifestUrl();

  let manifest;
  try {
    manifest = await fetchManifest(src);
  } catch (err) {
    // A bucket hiccup must never look like "you are up to date".
    return { status: "manifest-unreachable", installedVersion: installed, latestVersion: null, manifestUrl: src, error: err.message };
  }

  const latestVersion = manifest.version;
  const cmp = compareVersions(installed, latestVersion);
  const status = cmp === null ? "unknown-version" : cmp < 0 ? "update-available" : "up-to-date";
  return {
    status,
    installedVersion: installed,
    latestVersion,
    publishedAt: manifest.publishedAt ?? null,
    notes: manifest.notes ?? null,
    download: manifest.download ?? null,
    sha256: manifest.sha256 ?? null,
    manifestUrl: src,
  };
}

// ── Minimal ZIP reader (mirror of build-release.mjs's writer) ───────────────
// Parses the central directory, so entry order/extra fields do not matter.
function unzip(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method} for ${name}`);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
  }
  return entries;
}

// Refuse anything that would escape the extraction root (zip-slip).
function safeJoin(root, relPath) {
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + "/") && !target.startsWith(root + "\\")) {
    throw new Error(`refusing zip entry outside the skill directory: ${relPath}`);
  }
  return target;
}

// Download the release, verify its digest, and swap it into place. Only the
// skill directory is touched; credentials and caches (WALLET_KEY,
// .termix-a2a-session.env, .termix-a2a-runtime.env) live outside it.
export async function applyUpdate({ url, expectedSha256, expectedVersion } = {}) {
  if (!url) throw new Error("no download URL — the release manifest is missing `download`.");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(zipBuf).digest("hex");
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(`sha256 mismatch: manifest says ${expectedSha256}, downloaded bundle is ${digest} — refusing to install.`);
  }

  const files = unzip(zipBuf).filter((e) => e.name.startsWith(ZIP_SKILL_PREFIX) && !e.name.endsWith("/"));
  if (!files.length) throw new Error(`release bundle contains no ${ZIP_SKILL_PREFIX} entries — refusing to install.`);

  const staging = mkdtempSync(join(tmpdir(), "termix-skill-"));
  const newDir = join(staging, "new");
  try {
    for (const entry of files) {
      const target = safeJoin(newDir, entry.name.slice(ZIP_SKILL_PREFIX.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }
    if (!existsSync(join(newDir, "SKILL.md"))) {
      throw new Error("release bundle has no SKILL.md — refusing to install.");
    }

    // Keep the previous install until the new one is in place, so a failure
    // mid-swap never leaves the user without a skill.
    const backup = join(staging, "previous");
    if (existsSync(SKILL_DIR)) cpSync(SKILL_DIR, backup, { recursive: true });
    rmSync(SKILL_DIR, { recursive: true, force: true });
    try {
      renameSync(newDir, SKILL_DIR);
    } catch {
      // Cross-device rename (staging in /tmp, skill on another mount) → copy.
      cpSync(newDir, SKILL_DIR, { recursive: true });
    }
    if (!existsSync(join(SKILL_DIR, "SKILL.md"))) {
      if (existsSync(backup)) cpSync(backup, SKILL_DIR, { recursive: true });
      throw new Error("install verification failed — restored the previous skill directory.");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const installed = readInstalledVersion();
  return {
    status: "updated",
    installedVersion: installed,
    expectedVersion: expectedVersion ?? null,
    files: files.length,
    sha256: digest,
    skillDir: SKILL_DIR,
    note:
      installed && expectedVersion && installed !== expectedVersion
        ? `installed VERSION (${installed}) differs from the manifest version (${expectedVersion}).`
        : "Skill directory replaced. Re-read SKILL.md before continuing — docs and scripts may have changed.",
  };
}

const HOW_TO_UPDATE = [
  "node scripts/aacp-update.mjs apply   (downloads the released zip and replaces this skill directory)",
  "npx skills add TermiX-official/termix-agent-skills   (if installed via npx skills)",
  "update via the Claude Code /plugin marketplace UI (if installed as a plugin)",
];

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "check";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stderr.write("Usage: node aacp-update.mjs [check|apply]\nReads the public release manifest and optionally installs the newest release. See docs/upgrade.md.\n");
    process.exit(0);
  }
  if (command !== "check" && command !== "apply") {
    process.stderr.write(`Unknown command: ${command} (expected \`check\` or \`apply\`)\n`);
    process.exit(2);
  }

  const result = await checkForUpdate();
  if (command === "check") {
    if (result.status === "update-available") result.howToUpdate = HOW_TO_UPDATE;
    if (result.installedVersion === null) result.note = "No VERSION file found — running from a dev checkout; version comparison is unavailable.";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // apply
  if (result.status === "manifest-unreachable") {
    throw new Error(`cannot reach the release manifest: ${result.error}`);
  }
  if (result.installedVersion === null) {
    // No VERSION file means this is a source checkout, not an installed release —
    // overwriting it would destroy uncommitted work.
    throw new Error("no VERSION file next to SKILL.md — this looks like a dev checkout, not an installed release. Refusing to overwrite it; update via git instead.");
  }
  if (result.status === "up-to-date") {
    console.log(JSON.stringify({ status: "up-to-date", installedVersion: result.installedVersion, latestVersion: result.latestVersion, note: "Nothing to do." }, null, 2));
    return;
  }
  const applied = await applyUpdate({
    url: result.download,
    expectedSha256: result.sha256,
    expectedVersion: result.latestVersion,
  });
  console.log(JSON.stringify({
    ...applied,
    previousVersion: result.installedVersion,
    releaseNotes: result.notes ?? null,
    // An update is also a moment the user is waiting on a "so, now what?".
    next: "node scripts/aacp-next.mjs   (where the user is, and what to offer them next)",
  }, null, 2));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
