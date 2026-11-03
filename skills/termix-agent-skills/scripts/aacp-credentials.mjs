// Termix — which identity this terminal acts as, and the credential for it.
//
// THE POINT: a user who registered on the website already has an account, a
// wallet and agents there. Making them log in *again* with a different wallet
// gave them a second, empty account. So the skill can be LINKED to the web
// account instead: the website hands this terminal an API key
// (`aacp-link.mjs start`), every REST call is then made as that account, and
// anything that needs an on-chain signature is signed by the user's web wallet
// in the browser (`aacp-tx.mjs` opens the page). No Binance wallet needed.
//
// Two identities, one active at a time:
//   linked   — the web account's API key. Default whenever a link exists.
//   agentic  — the skill's own wallet session (Binance Agentic Wallet, or
//              `WALLET_KEY` in key mode), exactly as before linking existed.
//
// Every script that used to read the wallet session token reads
// `loadSessionToken()` from here instead. The backend accepts an API key in the
// same `Authorization: Bearer` slot, so a linked terminal needs no other change.
//
// Files (all per chain + backend, see chainCacheFile() in aacp-chain.mjs):
//   .termix-link.<chain>-<backend>.env     the key (0600) + who it belongs to
//   .termix-identity.<chain>-<backend>     one word: `linked` or `agentic`
//
// Zero dependencies, no side effects on import (house style for this skill).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeChainSlug, chainCacheFile, resolveApiBaseUrl } from "./aacp-chain.mjs";

// The exact 401 message the backend uses for an expired key (services/auth.ts
// API_KEY_EXPIRED_MESSAGE). A revoked key answers "Invalid API key" — different
// words, same cure: link again.
const LINK_EXPIRED_NEEDLE = "API key expired";

export function linkFilePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-link", ".env"));
}

export function identityFilePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-identity", ""));
}

// ── pure helpers (no I/O) ───────────────────────────────────────────────────

/** Parse a link file. Returns null when it holds no key. */
export function parseLinkFile(text) {
  const apiKey = text.match(/^TERMIX_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!apiKey) return null;
  // Metadata lives on `# ` comment lines, several `name=value` pairs per line.
  const meta = (name) => text.match(new RegExp(`^#.*?\\b${name}=(\\S*)`, "m"))?.[1] || null;
  return {
    apiKey,
    accountId: meta("account"),
    wallet: meta("wallet"),
    handle: meta("handle"),
    keyId: meta("keyId"),
    // "never" is written when the key has no expiry; anything else is ISO-8601.
    expiresAt: meta("expiresAt") === "never" ? null : meta("expiresAt"),
    issuedAt: meta("issuedAt"),
  };
}

/**
 * Which identity is active, from the two inputs that decide it. An explicit
 * identity file wins; otherwise having a link at all means linked. The file
 * saying `linked` with no link present falls back to agentic rather than to
 * "logged out", because that is the state the user was in before linking.
 */
export function resolveIdentity({ identityText, hasLink }) {
  const explicit = (identityText || "").trim().toLowerCase();
  if (explicit === "agentic") return "agentic";
  if (explicit === "linked") return hasLink ? "linked" : "agentic";
  return hasLink ? "linked" : "agentic";
}

/** Has this link's key passed its own expiry (as recorded at link time)? */
export function linkExpired(link, now = Date.now()) {
  if (!link?.expiresAt) return false;
  const t = Date.parse(link.expiresAt);
  return Number.isFinite(t) && t < now;
}

/** A 401 that means "the key is dead — link again", not "you are logged out". */
export function isLinkExpiredError(err) {
  if (!err || err.status !== 401) return false;
  const msg = String(err.message ?? "");
  return msg.includes(LINK_EXPIRED_NEEDLE) || msg.includes("Invalid API key");
}

// ── state on disk ───────────────────────────────────────────────────────────

/** The link for the selected chain, or null. `TERMIX_API_KEY` overrides the file (CI). */
export function loadLink() {
  const fromEnv = process.env.TERMIX_API_KEY?.trim();
  if (fromEnv) return { apiKey: fromEnv, accountId: null, wallet: null, handle: null, keyId: null, expiresAt: null, issuedAt: null, fromEnv: true };
  const path = linkFilePath();
  if (!existsSync(path)) return null;
  return parseLinkFile(readFileSync(path, "utf8"));
}

export function activeIdentity() {
  let identityText = null;
  try { identityText = readFileSync(identityFilePath(), "utf8"); } catch { /* no explicit choice */ }
  return resolveIdentity({ identityText, hasLink: Boolean(loadLink()) });
}

export function setIdentity(mode) {
  if (mode !== "linked" && mode !== "agentic") throw new Error(`identity must be "linked" or "agentic", got "${mode}"`);
  writeFileSync(identityFilePath(), `${mode}\n`, { mode: 0o600 });
}

export function writeLink({ apiKey, accountId, wallet, handle, keyId, expiresAt }) {
  const lines = [
    `# Termix web-account link — keep local, do NOT paste back to chat.`,
    `# This key acts as the web account below. Revoke it any time on the website (Account → Connected terminals).`,
    `# issuedAt=${new Date().toISOString()} chain=${activeChainSlug()} api=${resolveApiBaseUrl()}`,
    `# account=${accountId ?? ""} wallet=${wallet ?? ""} handle=${handle ?? ""} keyId=${keyId ?? ""} expiresAt=${expiresAt ?? "never"}`,
    `TERMIX_API_KEY=${apiKey}`,
    "",
  ];
  writeFileSync(linkFilePath(), lines.join("\n"), { mode: 0o600 });
}

export function clearLink() {
  for (const path of [linkFilePath(), identityFilePath()]) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

/**
 * The Bearer credential for account-scoped REST calls. Linked → the web
 * account's API key. Otherwise the wallet session cached by
 * `a2a-runtime.mjs login` (env `A2A_SESSION_TOKEN` overrides the file), which is
 * byte-for-byte what every script read before linking existed.
 */
export function loadSessionToken() {
  if (activeIdentity() === "linked") {
    const link = loadLink();
    if (link) return link.apiKey;
  }
  if (process.env.A2A_SESSION_TOKEN) return process.env.A2A_SESSION_TOKEN;
  const path = resolve(process.cwd(), chainCacheFile(".termix-a2a-session", ".env"));
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(/^A2A_SESSION_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Never show a whole credential — the first 12 chars identify it well enough. */
export function previewKey(key) {
  if (!key) return "(none)";
  return `${key.slice(0, 12)}…${key.slice(-4)} (${key.length} chars)`;
}

// Fingerprint the active credential without writing secrets into runtime metadata.
export function runtimeIdentityFingerprint() {
  const identity = activeIdentity();
  const credential = identity === "linked" ? loadLink()?.apiKey : `${loadSessionToken() ?? ""}:${process.env.TERMIX_WALLET_MODE ?? "agentic"}:${process.env.WALLET_KEY ?? ""}`;
  return createHash("sha256").update(`${identity}:${credential ?? ""}`).digest("hex");
}
