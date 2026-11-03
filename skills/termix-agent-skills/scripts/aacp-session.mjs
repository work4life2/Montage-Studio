// ──────────────────────────────────────────────────────────
// Wallet session — one login, shared by every script
// ──────────────────────────────────────────────────────────
//
// Identity order, same as the rest of the skill: linked › agentic › key.
//   linked  — the web account's API key IS the session (aacp-link.mjs); nothing
//             to refresh, and a 401 means "link again", not "sign in again".
//   agentic — the wallet session cached by `a2a-runtime.mjs login` (read via
//             loadSessionToken() by the quant commands before this module).
//   key     — lowest priority, explicit `TERMIX_WALLET_MODE=key` + `WALLET_KEY`:
//             this module can log in from the key on demand and refresh the
//             cached tokens in `.agent-mart-a2a-session.env` (mode 0600).
//
// `ensureSession()` is the entry point: it returns a usable access token,
// refreshing a lapsed one and, in key mode only, logging in from WALLET_KEY
// when nothing is cached. Callers never sequence a separate "log in first" step.
//
// The private key is used locally to produce an EIP-191 signature and nothing
// else. It is never written to disk, never sent over the network, and never
// printed.
//
// Zero dependencies, no side effects on import (house style for this skill).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, loadLink } from "./aacp-credentials.mjs";

export function sessionCachePath() {
  return resolve(process.cwd(), ".agent-mart-a2a-session.env");
}

export function requireWalletKey() {
  const key = process.env.WALLET_KEY?.trim();
  if (!key) throw new Error("WALLET_KEY env is required to sign a wallet login.");
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error("WALLET_KEY must be a 0x-prefixed 32-byte hex private key.");
  return key;
}

export function loadSession() {
  if (activeIdentity() === "linked") {
    const link = loadLink();
    if (link) return { access: link.apiKey, refresh: null, linked: true };
  }
  const fromEnv = process.env.A2A_SESSION_TOKEN?.trim();
  const path = sessionCachePath();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const access = fromEnv || text.match(/^A2A_SESSION_TOKEN=(.+)$/m)?.[1]?.trim() || null;
  const refresh = text.match(/^A2A_REFRESH_TOKEN=(.+)$/m)?.[1]?.trim() || null;
  return { access, refresh };
}

export function writeSession(accessToken, refreshToken, meta = {}) {
  const lines = [
    `# Termix wallet session — keep local, do NOT paste back to chat.`,
    `# Issued ${new Date().toISOString()} wallet=${meta.wallet ?? ""} account=${meta.account ?? ""}`,
    `A2A_SESSION_TOKEN=${accessToken}`,
    ...(refreshToken ? [`A2A_REFRESH_TOKEN=${refreshToken}`] : []),
    "",
  ];
  writeFileSync(sessionCachePath(), lines.join("\n"), { mode: 0o600 });
}

// Self-contained EIP-191 signer (vendored @noble bundle) so the skill signs
// logins without requiring viem/ethers in the host agent.
async function loadSigner() {
  return import(fileURLToPath(new URL("./vendor/eth-signer.mjs", import.meta.url)));
}

async function post(path, body, token) {
  const res = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`POST ${path} → HTTP ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Log in from WALLET_KEY: nonce → EIP-191 signature → cached session tokens. */
export async function walletLogin() {
  const pk = requireWalletKey();
  const { addressFromPrivateKey, signMessage } = await loadSigner();
  const address = addressFromPrivateKey(pk);
  const nonceRes = await post("/api/v1/auth/nonce", { walletAddress: address });
  const login = await post("/api/v1/auth/wallet", {
    walletAddress: address,
    nonce: nonceRes.nonce,
    signature: signMessage(pk, nonceRes.message),
  });
  writeSession(login.accessToken, login.refreshToken, { wallet: address, account: login.account?.id });
  return { ...login, address };
}

/**
 * A usable access token, obtained however it has to be:
 *   cached → refresh → full login from WALLET_KEY.
 *
 * This is what makes WALLET_KEY the single prerequisite: no command needs the
 * caller to have run `login` beforehand, and a long-running worker survives
 * token expiry unattended.
 *
 * `reissue: true` skips the cached token (use it after a 401).
 */
export async function ensureSession({ reissue = false } = {}) {
  const cached = loadSession();
  if (cached.linked) {
    // No refresh token and no key to log in with: a rejected API key can only
    // be replaced by linking again on the website.
    if (reissue) throw new Error("The web-account link is expired or revoked. Run `node scripts/aacp-link.mjs start` to link again.");
    return cached.access;
  }
  if (!reissue && cached.access) return cached.access;
  if (cached.refresh) {
    try {
      const res = await post("/api/v1/auth/refresh", { refreshToken: cached.refresh });
      writeSession(res.accessToken, cached.refresh, { wallet: res.account?.walletAddress, account: res.account?.id });
      return res.accessToken;
    } catch { /* refresh expired/revoked — fall through to a full login */ }
  }
  if (!process.env.WALLET_KEY) {
    throw new Error(
      "Not signed in. Link the web account (`node scripts/aacp-link.mjs start`), or log in with the Binance Agentic Wallet " +
        "(`node scripts/a2a-runtime.mjs login`); only in explicit key mode (TERMIX_WALLET_MODE=key) does WALLET_KEY log in automatically.",
    );
  }
  return (await walletLogin()).accessToken;
}

/** The cached token without ever logging in. For read paths that must not sign. */
export function requireSession() {
  const { access } = loadSession();
  if (!access) throw new Error("Not logged in. Link the web account with `aacp-link.mjs start`, run `a2a-runtime.mjs login` (agentic wallet), or — key mode only — set WALLET_KEY and re-run.");
  return access;
}

export function previewToken(token) {
  if (!token) return "(none)";
  return `${token.slice(0, 16)}…${token.slice(-8)} (${token.length} chars)`;
}
