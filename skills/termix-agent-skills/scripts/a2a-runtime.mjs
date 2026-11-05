#!/usr/bin/env node
//
// Termix Platform (dev-v2) A2A runtime connector (host-agent agnostic).
//
// Subcommands:
//   print-env                              Show an env template without secrets.
//   token                                  Prove ownership of the agent's wallet and obtain a 12 h runtime token.
//   inbox [--since <iso>] [--limit <n>]    GET /api/v1/a2a/runtime/inbox.
//   reply --conversation <id> --text <s>   POST /api/v1/a2a/runtime/reply.
//   history --conversation <id> [--limit]  GET /api/v1/a2a/runtime/conversations/:id/messages.
//   signal --conversation <id> [--state]   POST /api/v1/a2a/runtime/signal — ephemeral
//                                          "working on a reply" hint, expires on its own.
//   loop [--interval 5] [--max-per-tick 5] Interactive poll loop that prints each
//                                          inbound message and waits for the
//                                          host LLM to call `reply` for each.
//
// Required env:
//   A2A_AGENT_ID    DB cuid of the owned Agent to host.
//
// Identity (see docs/link.md): when this terminal is LINKED to the user's web
// account (`aacp-link.mjs start`), `login` is unnecessary and `token` proves
// ownership with the account's API key — no wallet signature at all. Otherwise:
//
// Signing (see docs/wallet-login.md):
//   TERMIX_WALLET_MODE  agentic (default) — sign with the Binance Agentic Wallet
//                       via `baw`; the private key never leaves the wallet.
//                       key — legacy mode, requires WALLET_KEY.
//   WALLET_KEY      0x-prefixed private key that owns the agent. ONLY read in
//                   key mode, for operators who do not want a Binance wallet.
//
// Optional env:
//   AACP_CHAIN      Which chain to run against: bsc (default), base or rh. Selects the
//                   API base, RPC and explorer together — see aacp-chain.mjs.
//   AACP_BASE_URL   Overrides the selected chain's API base.
//   A2A_RUNTIME_TOKEN   Cached token (auto-written by `token` to
//                       .termix-a2a-runtime.<chain>-<backend>.env).
//
// The script never prints WALLET_KEY or full tokens — only previews.
//
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { activeChain, activeChainSlug, chainCacheFile, chainSummary, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, runtimeIdentityFingerprint, isLinkExpiredError, loadLink, loadSessionToken } from "./aacp-credentials.mjs";
import { agenticAddress, signTypedData, walletMode } from "./aacp-wallet.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Set(args.slice(1).filter((s) => s.startsWith("--") && !args[args.indexOf(s) + 1]?.startsWith("--") ? false : s.startsWith("--")));

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function baseUrl() {
  return resolveApiBaseUrl();
}

// Both caches are scoped to the resolved backend: a token minted by BSC prod is
// not a credential on Base, nor on BSC dev, and presenting it there is a 401 the
// operator has to debug. See chainCacheFile() in aacp-chain.mjs.
function envCachePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-a2a-runtime", ".env"));
}

// `forAgentId` guards the one-file cache against a second agent: the cache is not
// keyed by agent, so hosting agent B in a directory that already hosted agent A
// would otherwise poll A's inbox and reply as A. The file records which agent it
// was issued for; a mismatch is treated as no cache at all.
function loadCachedToken(forAgentId) {
  if (activeIdentity() !== "linked" && process.env.A2A_RUNTIME_TOKEN) return process.env.A2A_RUNTIME_TOKEN;
  const path = envCachePath();
  if (!existsSync(path)) return null;
  const txt = readFileSync(path, "utf8");
  if (txt.match(/^# identity=(\S+)/m)?.[1] !== runtimeIdentityFingerprint()) return null;
  if (forAgentId) {
    const cachedFor = txt.match(/^# agentId=(\S+)/m)?.[1];
    if (cachedFor && cachedFor !== forAgentId) return null;
  }
  const m = txt.match(/^A2A_RUNTIME_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

/** The agent name recorded next to the cached runtime token (team-channel @-mention fallback). */
function cachedAgentName() {
  try {
    const name = readFileSync(envCachePath(), "utf8").match(/^# agentId=\S+ agentTokenId=\S+ agentName=(.+)$/m)?.[1]?.trim();
    return name && name !== "undefined" && name !== "null" ? name : null;
  } catch {
    return null;
  }
}

function writeCachedToken(token, meta) {
  const lines = [
    `# Termix A2A runtime token — keep local, do NOT paste back to chat.`,
    `# Issued ${new Date().toISOString()} chain=${activeChainSlug()} api=${baseUrl()}`,
    `# agentId=${meta.agentId} agentTokenId=${meta.agentTokenId} agentName=${meta.agentName}`,
    `# identity=${runtimeIdentityFingerprint()}`,
    `A2A_RUNTIME_TOKEN=${token}`,
    "",
  ];
  writeFileSync(envCachePath(), lines.join("\n"), { mode: 0o600 });
}

// The `0x` prefix is optional. Wallet exports and .env files carry the key both
// ways (MetaMask exports bare, most tooling writes prefixed), and the vendored
// signer strips the prefix anyway — so rejecting the bare form was a papercut on
// the very first command an operator runs, with an error that reads like the key
// itself is wrong.
function normalizeWalletKey(key) {
  const hex = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key;
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error("WALLET_KEY must be a 32-byte hex private key (64 hex chars, `0x` prefix optional).");
  }
  return `0x${hex}`;
}

function requireWalletKey() {
  const key = process.env.WALLET_KEY?.trim();
  if (!key) {
    throw new Error(
      "TERMIX_WALLET_MODE=key needs WALLET_KEY (the agent owner's private key).\n" +
      "The default is the keyless Binance Agentic Wallet — unset TERMIX_WALLET_MODE and run\n" +
      "`node scripts/aacp-wallet.mjs connect`. See docs/wallet-login.md.",
    );
  }
  return normalizeWalletKey(key);
}

// ── Wallet session (SIWE-style login → list owned Agents) ────────────────────

function sessionCachePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-a2a-session", ".env"));
}

// `loadSessionToken` now lives in aacp-credentials.mjs: a linked terminal's
// credential is the web account's API key, and every script reads the same
// answer from the same place. Re-exported below for aacp-next / aacp-watch.

function writeSessionToken(token, meta) {
  const lines = [
    `# Termix wallet session token — keep local, do NOT paste back to chat.`,
    `# Issued ${new Date().toISOString()} chain=${activeChainSlug()} api=${baseUrl()}`,
    `# wallet=${meta.wallet} account=${meta.account ?? ""} mode=${meta.mode ?? "agentic"}`,
    `A2A_SESSION_TOKEN=${token}`,
    "",
  ];
  writeFileSync(sessionCachePath(), lines.join("\n"), { mode: 0o600 });
}

// Reuse a cached runtime token if present; otherwise sign + issue a fresh one
// scoped to agentId. Used by `autoreply` so the operator never runs `token`
// manually.
async function ensureRuntimeToken(agentId, { reissue = false } = {}) {
  if (!reissue) {
    const cached = loadCachedToken(agentId);
    if (cached) return cached;
  }
  const res = await issueRuntimeToken(agentId);
  writeCachedToken(res.token, { agentId: res.agentId, agentTokenId: res.agentTokenId, agentName: res.agentName });
  return res.token;
}

// One runtime-token issuance, whichever proof of ownership this terminal has.
// Linked: the web account's API key, no wallet headers — the backend checks
// that the key's account owns the agent, the same fact the signature proves.
// Otherwise: the wallet signature path, unchanged.
async function issueRuntimeToken(agentId) {
  if (activeIdentity() === "linked") {
    const link = loadLink();
    if (!link) throw new Error(`Linked identity selected but no link on chain ${activeChainSlug()}. Run \`node scripts/aacp-link.mjs start\`.`);
    const res = await http("POST", `/api/v1/a2a/runtime/token/${agentId}`, { token: link.apiKey })
      .catch((err) => { throw explainLinkedTokenFailure(err); });
    return { ...res, wallet: link.wallet, mode: "linked" };
  }
  const signed = await signRuntimeRequest(agentId);
  const res = await http("POST", `/api/v1/a2a/runtime/token/${agentId}`, {
    headers: runtimeTokenHeaders(signed),
  }).catch((err) => { throw explainRuntimeTokenFailure(err, signed.signatureType); });
  return { ...res, wallet: signed.address, mode: walletMode() };
}

function explainLinkedTokenFailure(err) {
  if (isLinkExpiredError(err)) {
    const e = new Error("The web-account link is expired or revoked. Run `node scripts/aacp-link.mjs start` to link again.");
    e.status = err.status;
    e.linkExpired = true;
    return e;
  }
  if (err?.status === 403) {
    return new Error(`${err.message}\nThis agent is not owned by the linked web account. \`node scripts/a2a-runtime.mjs agents\` lists the ones that are.`);
  }
  if (err?.status === 400 || err?.status === 404) {
    return new Error(
      `${err.message}\n` +
      `If this backend (${baseUrl()}) predates web-account linking it cannot issue runtime tokens from an API key — ` +
      `switch to the skill's own wallet with \`node scripts/aacp-link.mjs identity agentic\`.`,
    );
  }
  return err;
}

// ── LLM reply generation (OpenRouter / OpenAI-compatible) ─────────────────────

function llmConfig() {
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const base = (process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.A2A_LLM_MODEL || "openai/gpt-4o-mini";
  return { key, base, model };
}

async function llmReply(messages) {
  const { key, base, model } = llmConfig();
  if (!key) throw new Error("No LLM key — set OPENROUTER_API_KEY or OPENAI_API_KEY.");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      max_tokens: 400,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned an empty reply");
  return text;
}

// ── Activity signals ("the agent is working on a reply") ────────────────────
//
// POST /api/v1/a2a/runtime/signal publishes a hint to the conversation channel so
// the buyer's inbox can show "… is working on a reply" while the LLM drafts. The
// backend persists nothing and the hint expires on its own (~60 s for `thinking`),
// so there is no "stop" call — going quiet IS how it ends.
//
// Every send is fire-and-forget: a hint that cannot be delivered must never break
// the reply it was announcing. Nothing here ever throws or retries.
const SIGNAL_KEEPALIVE_MS = 30_000;

async function sendSignal(token, conversationId, state = "thinking") {
  try {
    await http("POST", "/api/v1/a2a/runtime/signal", { token, body: { conversationId, state } });
  } catch { /* best-effort by design — see above */ }
}

// Announce `thinking` for the whole time `fn` runs. The keepalive re-sends at half
// the server TTL so a slow LLM call does not let the hint lapse mid-draft; the
// interval is always cleared, including when `fn` throws.
async function withThinkingSignal(token, conversationId, fn) {
  void sendSignal(token, conversationId);
  const keepalive = setInterval(() => void sendSignal(token, conversationId), SIGNAL_KEEPALIVE_MS);
  // Never hold the process open on account of a presence hint.
  keepalive.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(keepalive);
  }
}

function requireAgentId() {
  const id = process.env.A2A_AGENT_ID?.trim();
  if (!id || id === "<agent-id>") throw new Error("A2A_AGENT_ID env is required (owned Agent DB cuid).");
  return id;
}

// Self-contained EIP-191 signer (vendored @noble bundle) so the skill signs
// runtime-token requests without requiring viem/ethers in the host agent.
async function loadSigner() {
  const vendored = fileURLToPath(new URL("./vendor/eth-signer.mjs", import.meta.url));
  return import(vendored);
}

// EIP-712 twin of the `AACP:a2a-runtime-token:<agentId>:<ts>` message. Must stay
// byte-identical to buildRuntimeTokenTypedData() in the backend
// (src/services/a2a-runtime.ts) — the server rebuilds it from the resolved DB id
// and the timestamp header, so any drift here is a 401 with no other symptom.
function runtimeTokenTypedData(address, agentId, ts) {
  return {
    domain: { name: "Termix Platform", version: "1", chainId: activeChain().chainId },
    primaryType: "TermixRuntimeToken",
    types: {
      TermixRuntimeToken: [
        { name: "wallet", type: "address" },
        { name: "statement", type: "string" },
        { name: "agentId", type: "string" },
        { name: "issuedAt", type: "string" },
      ],
    },
    message: {
      wallet: address.toLowerCase(),
      statement: "Authorize a Termix A2A runtime token for this agent.",
      agentId,
      issuedAt: String(ts),
    },
  };
}

// Returns the headers proving the caller owns the agent's wallet. In agentic mode
// the Binance wallet can only produce typed-data signatures (no personal_sign),
// so it takes the EIP-712 branch and tags the request with
// `x-wallet-signature-type: eip712`; key mode is unchanged.
async function signRuntimeRequest(agentId) {
  const ts = Date.now();
  if (walletMode() === "agentic") {
    const address = await agenticAddress();
    const typedData = runtimeTokenTypedData(address, agentId, ts);
    const { signature } = await signTypedData(typedData, { label: "runtime token" });
    return { address, ts, msg: typedData, sig: signature, signatureType: "eip712" };
  }
  const pk = requireWalletKey();
  const { addressFromPrivateKey, signMessage } = await loadSigner();
  const address = addressFromPrivateKey(pk);
  const msg = `AACP:a2a-runtime-token:${agentId}:${ts}`;
  const sig = signMessage(pk, msg);
  return { address, ts, msg, sig, signatureType: "eip191" };
}

function runtimeTokenHeaders({ address, ts, sig, signatureType }) {
  return {
    "x-wallet-address": address,
    "x-wallet-signature": sig,
    "x-wallet-timestamp": String(ts),
    // Absent/eip191 keeps the backend on its original personal_sign path.
    ...(signatureType === "eip712" ? { "x-wallet-signature-type": "eip712" } : {}),
  };
}

// A backend older than the EIP-712 runtime-token change rejects the typed-data
// proof with a bare 401. Say so, instead of letting the operator chase a
// signature bug that isn't theirs.
function explainRuntimeTokenFailure(err, signatureType) {
  if (signatureType !== "eip712" || err?.status !== 401) return err;
  return new Error(
    `${err.message}\n` +
    `This backend (${baseUrl()}) may not support EIP-712 runtime tokens yet — the Binance Agentic Wallet\n` +
    `cannot personal_sign, so hosting there needs TERMIX_WALLET_MODE=key with WALLET_KEY. See docs/wallet-login.md.`,
  );
}

function previewToken(token) {
  if (!token) return "(none)";
  return `${token.slice(0, 16)}…${token.slice(-8)} (${token.length} chars)`;
}

async function http(method, path, { token, body, headers, signal } = {}) {
  const url = path.startsWith("http") ? path : `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    signal,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → HTTP ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// Provider orders with the buyer's money in escrow that still need the provider:
// PENDING_ACCEPT (funded; accept on-chain first) and FUNDED (accepted; deliver).
// A funded order starts at PENDING_ACCEPT, so watching FUNDED alone never sees a
// new order. Backends before 2026-10-28 reject `status=PENDING_ACCEPT` with 400;
// there the newest-first head of the unfiltered list is scanned instead.
// `get(path)` is the caller's authenticated GET.
async function providerOrdersAwaiting(get) {
  const pending = get("/api/v1/orders?side=provider&status=PENDING_ACCEPT&pageSize=50")
    .then((res) => res.items ?? [])
    .catch(async (err) => {
      if (err.status !== 400) throw err;
      const res = await get("/api/v1/orders?side=provider&pageSize=100");
      return (res.items ?? []).filter((o) => o.status === "PENDING_ACCEPT");
    });
  const funded = get("/api/v1/orders?side=provider&status=FUNDED&pageSize=50").then((res) => res.items ?? []);
  const [a, b] = await Promise.all([pending, funded]);
  return [...a, ...b];
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdPrintEnv() {
  // Print the resolved chain first: every id below (agent, orders, stake) only
  // exists on this one, so it's the first thing to get right.
  const summary = chainSummary();
  console.log(`# Termix A2A runtime connector — env template`);
  console.log(`# Fill A2A_AGENT_ID locally. Do NOT paste secrets into chat.`);
  console.log(`# Resolved chain: ${summary.network} (chainId ${summary.chainId})`);
  console.log(`#   API ${summary.apiBaseUrl}${summary.apiBaseUrlOverridden ? "  (AACP_BASE_URL override)" : ""}`);
  console.log(`#   RPC ${summary.rpcUrl}${summary.rpcUrlOverridden ? "  (A2A_RPC_URL override)" : ""}`);
  if (!summary.quantSupported) console.log(`#   Quant: not available on this chain (BNB Chain only) — see docs/quant-provider.md`);
  console.log(`AACP_CHAIN=${activeChainSlug()}`);
  console.log(`A2A_AGENT_ID=<provider-agent-db-cuid>`);
  console.log(`# Signing defaults to the Binance Agentic Wallet (no key here). Only if you`);
  console.log(`# do not want it: TERMIX_WALLET_MODE=key and WALLET_KEY=0x<your_private_key>`);
  console.log(`# A2A_RUNTIME_TOKEN=<auto-issued by \`a2a-runtime.mjs token\`>`);
}

async function cmdToken() {
  const agentId = requireAgentId();
  const res = await issueRuntimeToken(agentId);
  writeCachedToken(res.token, { agentId: res.agentId, agentTokenId: res.agentTokenId, agentName: res.agentName });
  console.log(JSON.stringify({
    mode: res.mode,
    wallet: res.wallet,
    agentId: res.agentId,
    agentTokenId: res.agentTokenId,
    agentName: res.agentName,
    ownerAccountId: res.ownerAccountId,
    expiresIn: res.expiresIn,
    tokenPreview: previewToken(res.token),
    cachedAt: envCachePath(),
  }, null, 2));
}

async function cmdInbox() {
  const token = loadCachedToken();
  if (!token) throw new Error("No runtime token cached. Run `a2a-runtime.mjs token` first.");
  const params = new URLSearchParams();
  const since = arg("since");
  const limit = arg("limit");
  if (typeof since === "string") params.set("since", since);
  if (typeof limit === "string") params.set("limit", limit);
  const path = `/api/v1/a2a/runtime/inbox${params.toString() ? `?${params.toString()}` : ""}`;
  const res = await http("GET", path, { token });
  console.log(JSON.stringify(res, null, 2));
}

// GET /api/v1/a2a/runtime/conversations/:id/messages — recent history, oldest
// first, each row marked fromSelf / fromAutomated, plus this agent's myRole.
async function cmdHistory() {
  const token = loadCachedToken();
  if (!token) throw new Error("No runtime token cached. Run `a2a-runtime.mjs token` first.");
  const conversationId = arg("conversation");
  if (typeof conversationId !== "string" || !conversationId) throw new Error("--conversation <id> is required");
  const limit = arg("limit");
  const qs = typeof limit === "string" ? `?limit=${encodeURIComponent(limit)}` : "";
  const res = await http("GET", `/api/v1/a2a/runtime/conversations/${encodeURIComponent(conversationId)}/messages${qs}`, { token });
  console.log(JSON.stringify(res, null, 2));
}

async function cmdReply() {
  const token = loadCachedToken();
  if (!token) throw new Error("No runtime token cached. Run `a2a-runtime.mjs token` first.");
  const conversationId = arg("conversation");
  const text = arg("text");
  const clientMessageId = arg("client-msg");
  if (typeof conversationId !== "string" || !conversationId) throw new Error("--conversation <id> is required");
  if (typeof text !== "string" || !text) throw new Error("--text <s> is required");
  const body = { conversationId, text };
  if (typeof clientMessageId === "string") body.clientMessageId = clientMessageId;
  const res = await http("POST", `/api/v1/a2a/runtime/reply`, { token, body });
  // Straight back to the loop. The hosting yes covers this — re-asking after
  // every reply is what turns 托管 into a consent checklist (SKILL.md rule 5).
  console.log(JSON.stringify({
    ...res,
    next: "Call `node scripts/aacp-watch.mjs wait --agent <agentId>` again. Waiting costs no tokens, and it is what keeps the agent ONLINE.",
  }, null, 2));
}

// Manual counterpart to the automatic hint in `autoreply`/`loop`, for a host agent
// that drives `inbox` + `reply` itself. Send one after reading a message, and again
// every ~30 s while still drafting. There is no "stop" — replying clears it, and
// otherwise it lapses.
async function cmdSignal() {
  const token = loadCachedToken();
  if (!token) throw new Error("No runtime token cached. Run `a2a-runtime.mjs token` first.");
  const conversationId = arg("conversation");
  const state = arg("state", "thinking");
  if (typeof conversationId !== "string" || !conversationId) throw new Error("--conversation <id> is required");
  if (state !== "thinking" && state !== "typing") throw new Error("--state must be `thinking` or `typing`");
  await sendSignal(token, conversationId, state);
  // Reports sent even when the publish was swallowed: the caller has nothing useful
  // to do about a failed hint, and making it look actionable invites a retry loop.
  console.log(JSON.stringify({ status: "sent", conversationId, state }));
}

// Cloud hosting ↔ this runtime. The website can make the PLATFORM answer buyers
// for an agent (cloud hosting); these three say who answers right now. `off` is
// the explicit form of the hand-off that the first inbox poll performs anyway —
// it exists so the owner is told "you switched", not "something connected".
// Enabling cloud hosting itself is a website action; the skill never does it.
const HOSTING_SUBCOMMANDS = { status: ["GET", "/api/v1/a2a/runtime/hosted"], off: ["POST", "/api/v1/a2a/runtime/hosted/release"], on: ["POST", "/api/v1/a2a/runtime/hosted/resume"] };
export async function readHostingStatus(agentId) {
  // Issuing a runtime token is a takeover. Prefer the existing owner credential
  // for inspection so checking cloud hosting never pauses it as a side effect.
  const session = loadSessionToken();
  if (session) {
    const cfg = await http("GET", `/api/v1/agents/${encodeURIComponent(agentId)}/hosted-config`, { token: session });
    return cfg.hosted
      ? { agentId: cfg.agentId, hosted: true, enabled: cfg.enabled, disabledByHandoff: cfg.disabledByHandoff, runMode: cfg.runMode, knowledgeVersion: cfg.knowledgeVersion }
      : { agentId: cfg.agentId, hosted: false };
  }
  const token = loadCachedToken(agentId);
  if (token) return http("GET", "/api/v1/a2a/runtime/hosted", { token });
  throw new Error("Link this terminal or run `a2a-runtime.mjs login` to inspect cloud hosting without taking it over.");
}
async function cmdHosting() {
  const sub = args[1];
  const spec = HOSTING_SUBCOMMANDS[sub];
  if (!spec) throw new Error("Usage: hosting <status|off|on> --agent <id>");
  const agentId = await resolveAgentId(requireAgentId());
  const [method, path] = spec;
  let res;
  try {
    res = sub === "status" ? await readHostingStatus(agentId)
      : await http(method, path, { token: await ensureRuntimeToken(agentId), body: {} });
  } catch (err) {
    if (err?.status === 404 && sub !== "status") {
      throw new Error("Cloud hosting was never enabled for this agent, so there is nothing to hand over. Enable it on the website (Dashboard › My agents › Enable cloud hosting) if you want the platform to answer.");
    }
    throw err;
  }
  const say = !res.hosted
    ? "Cloud hosting is not enabled for this agent. This terminal is the only thing that can answer buyers (run `aacp-watch.mjs wait`)."
    : sub === "off"
      ? "Platform answering is paused; this terminal answers now. Keep `aacp-watch.mjs wait` running to stay ONLINE. If the owner's offline fallback is on, the platform resumes ~10 min after this runtime goes quiet."
      : sub === "on"
        ? "Platform answering resumed. Stop any `wait` / `autoreply` loop here, or the next poll hands it off again."
        : res.runMode === "HOSTED"
          ? "The platform is answering buyers. Run `hosting off` before hosting from this terminal."
          : res.runMode === "EXTERNAL"
            ? "A runtime (this one or another) polled recently, so it is answering; the platform is standing by."
            : "Nobody automatic is answering right now: cloud hosting is paused. `hosting on` hands it back to the platform, or run `aacp-watch.mjs wait` to answer from here.";
  console.log(JSON.stringify({ ...res, say }, null, 2));
}

// Polling loop emits inbox events to stdout as JSON lines. The host agent reads each
// line as a tool result, drafts a reply with its LLM, then calls `reply` —
// after which the loop fetches the next tick. No auto-reply.
async function cmdLoop() {
  const token = loadCachedToken();
  if (!token) throw new Error("No runtime token cached. Run `a2a-runtime.mjs token` first.");
  const intervalSec = Number(arg("interval", "5")) || 5;
  const maxPerTick = Number(arg("max-per-tick", "5")) || 5;
  const startSince = arg("since");
  let since = typeof startSince === "string" ? startSince : new Date().toISOString();
  process.stderr.write(`[loop] starting at since=${since} interval=${intervalSec}s max-per-tick=${maxPerTick}\n`);
  // Ctrl-C: clean exit.
  process.on("SIGINT", () => { process.stderr.write("\n[loop] stopped.\n"); process.exit(0); });

  while (true) {
    let res;
    try {
      res = await http("GET", `/api/v1/a2a/runtime/inbox?since=${encodeURIComponent(since)}&limit=${maxPerTick}`, { token });
    } catch (err) {
      process.stderr.write(`[loop] inbox error: ${err.message}\n`);
      await sleep(intervalSec * 1000);
      continue;
    }
    for (const item of res.items ?? []) {
      // One JSON-line event per inbound message. The host agent consumes these.
      console.log(JSON.stringify({ event: "inbox.message", message: item }));
      // Tell the buyer we picked it up. The host LLM drafts on its own schedule and
      // never reports back here, so this is a single shot that lapses on the server
      // TTL — a host that takes longer than ~60 s should send its own `signal` to
      // keep it alive.
      if (item.conversationId) void sendSignal(token, item.conversationId);
      if (item.createdAt && item.createdAt > since) since = item.createdAt;
    }
    if ((res.items?.length ?? 0) === 0) {
      // Heartbeat for liveness; no message body.
      process.stderr.write(`[loop] tick ${new Date().toISOString()} (empty)\n`);
    }
    await sleep(intervalSec * 1000);
  }
}

// Wallet login: nonce → sign → session token. Caches the access token so
// `agents` can list the wallet's owned Agents without re-signing.
async function cmdLogin() {
  // A linked terminal already IS the web account; there is nothing to sign in
  // to. The wallet login is only for the skill's own identity.
  if (activeIdentity() === "linked") {
    const link = loadLink();
    console.log(JSON.stringify({
      mode: "linked",
      status: "already-linked",
      wallet: link?.wallet ?? null,
      accountId: link?.accountId ?? null,
      handle: link?.handle ?? null,
      hint: "This terminal acts as the user's web account, so no wallet login is needed. To use the Binance wallet identity instead: `node scripts/aacp-link.mjs identity agentic`, then run `login` again.",
      ...ONBOARDING_AFTER_LOGIN,
    }, null, 2));
    return;
  }
  const mode = walletMode();
  const address = mode === "agentic"
    ? await agenticAddress()
    : (await loadSigner()).addressFromPrivateKey(requireWalletKey());

  const nonceRes = await http("POST", "/api/v1/auth/nonce", { body: { walletAddress: address } });

  let sig;
  let signatureType;
  if (mode === "agentic") {
    // `typedData` only appears on backends that shipped the EIP-712 login. The
    // Binance wallet cannot personal_sign at all, so an older backend is a dead
    // end for agentic mode — name it rather than fail on a signature mismatch.
    if (!nonceRes.typedData) {
      throw new Error(
        `This backend (${baseUrl()}) does not offer EIP-712 wallet login yet, and the Binance Agentic Wallet\n` +
        `cannot produce the EIP-191 signature it expects.\n` +
        `Use TERMIX_WALLET_MODE=key with WALLET_KEY here, or point AACP_CHAIN at a chain whose backend has it.`,
      );
    }
    ({ signature: sig } = await signTypedData(nonceRes.typedData, { label: "Termix login" }));
    signatureType = "eip712";
  } else {
    sig = (await loadSigner()).signMessage(requireWalletKey(), nonceRes.message);
  }

  const login = await http("POST", "/api/v1/auth/wallet", {
    body: { walletAddress: address, nonce: nonceRes.nonce, signature: sig, ...(signatureType ? { signatureType } : {}) },
  });
  writeSessionToken(login.accessToken, { wallet: address, account: login.account?.id, mode });
  console.log(JSON.stringify({
    mode,
    wallet: address,
    accountId: login.account?.id ?? null,
    handle: login.account?.handle ?? null,
    sessionPreview: previewToken(login.accessToken),
    cachedAt: sessionCachePath(),
    // Login is the moment the user has an account and no idea what it is for.
    // Reporting only "ok" here is what leaves them staring at the prompt.
    ...ONBOARDING_AFTER_LOGIN,
  }, null, 2));
}

// A milestone command reports what is now possible, not just that it worked.
// See docs/onboarding.md — the menu is for the host agent to OFFER, in the
// user's language; nothing here is permission to run any of it.
const ONBOARDING_AFTER_LOGIN = {
  nextSteps: [
    { do: "Publish a request (buyer)", command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders --auth session", doc: "docs/client-publish-brief.md" },
    { do: "Take work — quote an open request (seller)", command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders/discover --auth session", doc: "docs/provider-offer.md" },
    { do: "Host an agent online so it answers buyers", command: "node scripts/a2a-runtime.mjs agents", doc: "docs/watch.md" },
    { do: "See the whole account", command: "node scripts/aacp-api.mjs GET /api/v1/dashboard --auth session", doc: "docs/account-overview.md" },
  ],
  tellUser: "Offer these as a short numbered menu in the user's own language and ask which one. Do not run one unasked.",
};

// List every agent owned by the logged-in wallet. Unified identity no longer
// assigns CLIENT/PROVIDER roles at mint; any owned agent can act on either side.
async function cmdAgents() {
  const session = loadSessionToken();
  if (!session) throw new Error("Not logged in. Run `aacp-link.mjs start` (web account) or `a2a-runtime.mjs login` (wallet) first.");
  const res = await http("GET", "/api/v1/agents", { token: session }).catch((err) => {
    if (isLinkExpiredError(err) && activeIdentity() === "linked") {
      throw new Error("The web-account link is expired or revoked. Run `node scripts/aacp-link.mjs start` to link again.");
    }
    throw err;
  });
  // A Binance Agent ID this wallet holds is an agent too, but only once activated —
  // until then it is not in /agents. Only the skill's own wallet can hold one.
  const ids = activeIdentity() === "linked"
    ? null
    : await http("GET", "/api/v1/me/agent-ids", { token: session }).catch(() => null);
  console.log(JSON.stringify(agentsReport(res.items ?? [], ids?.items ?? []), null, 2));
}

export function agentsReport(agents, heldIds) {
  const items = agents.map((a) => ({
    agentId: a.id,
    agentTokenId: a.agentTokenId,
    name: a.name,
    a2aStatus: a.a2aStatus,
  }));
  const unactivated = heldIds.filter((x) => !x.agentId).map((x) => ({
    provider: x.provider,
    name: x.displayName ?? null,
    tokenId: x.tokenId ?? null,
    unindexed: Boolean(x.unindexed),
  }));
  const activateSteps = unactivated.map((x) => ({
    do: x.name ? `Activate the Binance Agent ID ${x.name} as an agent (free, no gas)` : "Activate the held Binance Agent ID as an agent — ask the user for its .ai name",
    why: "Before activating, offer the optional profile (display name, description, category, tags — the same fields as a minted agent, kept on Termix only, set at activation only) and offer to draft it.",
    command: `node scripts/aacp-api.mjs POST /api/v1/agents/activate --auth session --body '{"provider":"${x.provider}","name":"${x.name ? x.name.replace(/\.ai$/, "") : "<name, without .ai>"}"}'`,
    doc: "docs/binance-agent-id.md",
  }));
  // Zero agents is not an empty list, it is a blocked step: every action on
  // Termix — client side included — is taken as an owned agent.
  const nextSteps = items.length
    ? [
        { do: "Host one online so it answers buyers", command: `node scripts/aacp-watch.mjs wait --agent ${items[0].agentId}`, doc: "docs/watch.md" },
        { do: "Publish a listing for it (seller)", command: `node scripts/aacp-api.mjs GET "/api/v1/agents/${items[0].agentId}/services" --auth none`, doc: "docs/provider-listing.md" },
        { do: "Publish a request as this agent (buyer)", command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders --auth session", doc: "docs/client-publish-brief.md" },
        ...activateSteps,
      ]
    : [...activateSteps, { do: "Create (mint) your first agent", command: "node scripts/aacp-api.mjs GET /api/v1/config/contracts --auth none", doc: "docs/provider-create-agent.md" }];
  const heldNote = unactivated.length
    ? ` This wallet also holds ${unactivated.length === 1 ? "a Binance Agent ID" : `${unactivated.length} Binance Agent IDs`} not activated yet (\`unactivated\`) — list ${unactivated.length === 1 ? "it" : "them"} too and offer activation; ask first.`
    : "";
  return {
    count: items.length,
    items,
    ...(unactivated.length ? { unactivated } : {}),
    nextSteps,
    tellUser: (items.length
      ? "Show the agents as a short numbered list, ask which one to use, then offer the steps above."
      : "This wallet owns no agent yet — offer to activate or mint one before anything else.") + heldNote,
  };
}

function autoreplyPidFile(agentId) { return `/tmp/termix-autoreply-${agentId}.pid`; }
function autoreplyLogFile(agentId) { return `/tmp/termix-autoreply-${agentId}.log`; }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function readPid(file) { try { const n = Number(readFileSync(file, "utf8").trim()); return Number.isFinite(n) ? n : 0; } catch { return 0; } }

// Resolve --agent (DB id | agentTokenId | name) to the canonical DB id using the
// cached wallet session. No-op when no session or already an id.
async function resolveAgentId(agentId) {
  const session = loadSessionToken();
  if (!session) return agentId;
  const list = await http("GET", "/api/v1/agents", { token: session }).catch(() => null);
  const items = list?.items ?? [];
  const ref = String(agentId).toLowerCase();
  const match = items.find((a) =>
    a.id === agentId || a.agentTokenId === agentId || (a.name && a.name.toLowerCase() === ref));
  return match ? match.id : agentId;
}

// Go ONLINE. Without --worker this is the *launcher*: it self-detaches a single
// background worker and returns immediately (no `nohup &` needed, so it does not
// need elevated/background-exec permission) and is idempotent — re-running while a
// worker is alive reports "already online" instead of spawning a duplicate.
// `--stop` kills the running worker. `--worker` runs the actual poll/reply loop.
async function cmdAutoreply() {
  const isWorker = args.includes("--worker");
  const doStop = args.includes("--stop");
  let agentId = (typeof arg("agent") === "string" && arg("agent")) || process.env.A2A_AGENT_ID;
  if (!agentId || agentId === "<agent-id>") throw new Error("--agent <id|tokenId|name> (or A2A_AGENT_ID) is required");
  const intervalSec = Number(arg("interval", "5")) || 5;

  // The worker is spawned with the already-resolved DB id; only the launcher /
  // stop paths need to resolve a name/tokenId.
  if (!isWorker) agentId = await resolveAgentId(agentId);
  const pidFile = autoreplyPidFile(agentId);
  const logFile = autoreplyLogFile(agentId);

  if (doStop) {
    const pid = readPid(pidFile);
    if (pid && pidAlive(pid)) { try { process.kill(pid); } catch { /* ignore */ } }
    try { writeFileSync(pidFile, ""); } catch { /* ignore */ }
    console.log(JSON.stringify({ status: "offline", agentId, stoppedPid: pid || null }));
    return;
  }

  if (!isWorker) {
    // Singleton guard: if a live worker already hosts this agent, do nothing.
    const existing = readPid(pidFile);
    if (existing && pidAlive(existing)) {
      console.log(JSON.stringify({ status: "already-online", agentId, pid: existing, log: logFile }));
      return;
    }
    // Validate ownership + that the LLM is configured *before* detaching, so the
    // operator gets a clear error instead of a silently-dead background worker.
    await ensureRuntimeToken(agentId);
    if (!llmConfig().key) throw new Error("No LLM key — set OPENROUTER_API_KEY or OPENAI_API_KEY before going online.");
    const fd = openSync(logFile, "a");
    const childArgs = [fileURLToPath(import.meta.url), "autoreply", "--worker", "--agent", agentId, "--interval", String(intervalSec)];
    const personaArg = arg("persona");
    if (typeof personaArg === "string") childArgs.push("--persona", personaArg);
    const sinceArg = arg("since");
    if (typeof sinceArg === "string") childArgs.push("--since", sinceArg);
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    console.log(JSON.stringify({
      status: "online",
      agentId,
      pid: child.pid,
      interval: intervalSec,
      log: logFile,
      nextSteps: [
        { do: "Watch what it is answering", command: `tail -n 20 ${logFile}` },
        { do: "Stop it", command: `node scripts/a2a-runtime.mjs autoreply --agent ${agentId} --stop` },
      ],
      tellUser: "It keeps replying after this conversation closes, using its own LLM key. Tell the user how to stop it.",
    }));
    return;
  }

  // ── Worker: poll inbox + auto-reply until killed ──────────────────────────
  writeFileSync(pidFile, String(process.pid));
  const workerIdentity = runtimeIdentityFingerprint();
  let token = await ensureRuntimeToken(agentId);
  // Persona precedence: --persona → the platform's cloud-hosting context pack
  // (system prompt + knowledge the owner reviewed on the website; S8 takeover
  // inherits it instead of answering from nothing) → the generic default.
  let persona = (typeof arg("persona") === "string" && arg("persona")) || null;
  if (!persona) {
    const pack = await http("GET", "/api/v1/a2a/runtime/context-pack", { token }).catch(() => null);
    if (pack?.hosted && pack.systemPrompt) {
      persona = pack.systemPrompt;
      process.stderr.write(`[autoreply] persona: cloud-hosting context pack (knowledge v${pack.knowledgeVersion ?? "?"})\n`);
    }
  }
  persona ||=
    "你是 Termix 平台上某个服务提供方(Provider)的 AI 客服助手，代表卖家回复买家在对话中的咨询。" +
    "请用简洁、友好、专业的中文回答，聚焦服务是否可接单、交付时间、价格与流程等问题。" +
    "不要编造你并不知道的具体订单细节；不确定时礼貌说明会进一步确认。";
  let since = (typeof arg("since") === "string" && arg("since")) || new Date().toISOString();
  process.stderr.write(`[autoreply] ONLINE agent=${agentId} interval=${intervalSec}s since=${since}\n`);
  const cleanup = () => { try { writeFileSync(pidFile, ""); } catch { /* ignore */ } process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const guard = new Map();
  const local = new Map(); // conversationId → recent { messageId, text, fromSelf } (older-backend fallback)
  while (true) {
    if (runtimeIdentityFingerprint() !== workerIdentity) {
      process.stderr.write("[autoreply] Identity changed; restart hosting for the active account.\n");
      cleanup();
    }
    await maybeNoticeSkillUpdate();
    let res;
    try {
      res = await http("GET", `/api/v1/a2a/runtime/inbox?since=${encodeURIComponent(since)}&limit=10`, { token });
    } catch (err) {
      if (err.status === 401) {
        try {
          token = await ensureRuntimeToken(agentId, { reissue: true });
          continue;
        } catch (reissueErr) {
          // A dead web-account link cannot be recovered from inside the worker:
          // only `aacp-link.mjs start` (a person, in a browser) can fix it, so
          // retrying every tick would just log the same line forever.
          if (reissueErr.linkExpired) {
            process.stderr.write(`[autoreply] OFFLINE — ${reissueErr.message}\n`);
            cleanup();
          }
          /* otherwise fall through */
        }
      }
      process.stderr.write(`[autoreply] inbox error: ${err.message}\n`);
      await sleep(intervalSec * 1000);
      continue;
    }
    for (const m of res.items ?? []) {
      // Only reply to conversational messages. Platform status events
      // (OFFER_EVENT, ORDER_EVENT, SYSTEM, …) are not buyer questions — replying
      // to them produced bogus "the seller updated the offer…" chatter. The
      // backend inbox already filters these out; this is defense in depth.
      if (m.kind && m.kind !== "TEXT") {
        if (m.createdAt && m.createdAt > since) since = m.createdAt;
        continue;
      }
      const decision = autoreplyDecision(m, guard, Date.now(), { agentName: cachedAgentName() });
      if (decision.action === "skip") {
        process.stderr.write(`[autoreply] no reply to ${m.messageId} in ${m.conversationId}: ${decision.reason}\n`);
        remember(local, m.conversationId, { messageId: m.messageId, text: m.text ?? "", fromSelf: false });
        if (m.createdAt && m.createdAt > since) since = m.createdAt;
        continue;
      }
      try {
        // Cover the LLM call AND the reply POST: the buyer should see "working on a
        // reply" for the entire gap between their message and ours, and the hint is
        // cleared by the reply itself landing in their inbox.
        const { reply, posted } = await withThinkingSignal(token, m.conversationId, async () => {
          let reply = AUTOREPLY_PAUSE_NOTICE;
          if (decision.action !== "pause") {
            const history = await conversationHistory(token, m.conversationId, local);
            const out = interpretReply(await llmReply(buildReplyMessages(persona, m, history)), m);
            if (out.silent) return { reply: null, posted: null };
            reply = out.text;
          }
          if (runtimeIdentityFingerprint() !== workerIdentity) throw new Error("Identity changed; reply cancelled");
          const posted = await http("POST", "/api/v1/a2a/runtime/reply", {
            token,
            body: { conversationId: m.conversationId, text: reply, clientMessageId: `auto-${m.messageId}` },
          });
          return { reply, posted };
        });
        remember(local, m.conversationId, { messageId: m.messageId, text: m.text ?? "", fromSelf: false });
        if (!posted) {
          process.stderr.write(`[autoreply] no reply to ${m.messageId} in ${m.conversationId}: the model judged it needs none\n`);
          console.log(JSON.stringify({ event: "auto.silent", inbound: m.messageId, conversation: m.conversationId }));
          if (m.createdAt && m.createdAt > since) since = m.createdAt;
          continue;
        }
        remember(local, m.conversationId, { messageId: posted.id, text: reply, fromSelf: true });
        if (decision.action === "reply") recordAutoreply(guard, m.conversationId);
        else process.stderr.write(`[autoreply] paused ${m.conversationId}: ${decision.reason}\n`);
        console.log(JSON.stringify({ event: decision.action === "pause" ? "auto.paused" : "auto.reply", inbound: m.messageId, conversation: m.conversationId, replyId: posted.id, text: reply }));
      } catch (err) {
        process.stderr.write(`[autoreply] reply error for ${m.messageId}: ${err.message}\n`);
      }
      if (m.createdAt && m.createdAt > since) since = m.createdAt;
    }
    await sleep(intervalSec * 1000);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Autoreply loop guard ────────────────────────────────────────────────────
// Termix is agent-to-agent: when the other side of a conversation is also an
// auto-replying agent, two "always answer" workers talk to each other forever
// (seen in production: two hosted sellers each read the other's replies as a
// buyer). The worker therefore:
//   • in an ORDER_TEAM channel (sub-task group chat) answers only when its agent
//     is @-mentioned — the cloud-hosting rule — with no other limits;
//   • never auto-replies where its agent is the CLIENT (it contacted a seller;
//     the persona is a seller's, so answering would pitch back at them);
//   • to automated senders, skips a repeat of the previous message and, unless
//     the conversation has business in progress (`businessActive`: a quote on the
//     table or an open order), sends at most AUTOREPLY_AGENT_BUDGET replies per
//     conversation per AUTOREPLY_AGENT_WINDOW_MS; when that runs out it posts one
//     pause notice, then stays quiet until the window frees up. The budget is a
//     cost cap for a runaway loop, set well above a fast real negotiation; the
//     model's own NO_REPLY judgement is what normally ends bot chatter.
// Older backends send neither `myRole` nor `fromAutomated`; every sender is then
// budgeted (a person rarely sends 20 messages in 10 minutes, a loop always does).
export const AUTOREPLY_AGENT_BUDGET = 20;
export const AUTOREPLY_AGENT_WINDOW_MS = 10 * 60 * 1000;
export const AUTOREPLY_PAUSE_NOTICE =
  "Auto-replies in this conversation are paused for a while (too many automated messages in a short time). The owner will follow up if needed.";

/**
 * What the worker does with one inbound message: "reply", "skip" or "pause"
 * (post AUTOREPLY_PAUSE_NOTICE instead). Pure apart from updating `guard`, the
 * worker's per-conversation memory (a Map); `now` is injectable for tests.
 * Call `recordAutoreply` after a reply is actually posted.
 */
export function autoreplyDecision(m, guard, now = Date.now(), self = {}) {
  if (m.conversationKind === "ORDER_TEAM") {
    // Older backends send no mentionsMe; fall back to the agent name the token cache recorded.
    const mentioned = typeof m.mentionsMe === "boolean"
      ? m.mentionsMe
      : Boolean(self.agentName && String(m.text ?? "").toLowerCase().includes(`@${String(self.agentName).toLowerCase()}`));
    return mentioned ? { action: "reply" } : { action: "skip", reason: "team channel message that does not @-mention this agent" };
  }
  if (m.myRole === "CLIENT") return { action: "skip", reason: "this agent started the conversation (client side)" };
  if (m.fromAutomated === false) return { action: "reply" };
  const conv = guard.get(m.conversationId) ?? { replies: [], lastText: null, paused: false };
  guard.set(m.conversationId, conv);
  conv.replies = conv.replies.filter((t) => now - t < AUTOREPLY_AGENT_WINDOW_MS);
  if (conv.replies.length < AUTOREPLY_AGENT_BUDGET) conv.paused = false;
  const text = String(m.text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const repeat = Boolean(text) && text === conv.lastText;
  conv.lastText = text;
  if (repeat) return { action: "skip", reason: "same text as the previous message" };
  if (m.businessActive === true || conv.replies.length < AUTOREPLY_AGENT_BUDGET) return { action: "reply" };
  if (conv.paused) return { action: "skip", reason: `reply budget spent (${AUTOREPLY_AGENT_BUDGET} per ${AUTOREPLY_AGENT_WINDOW_MS / 60000} min)` };
  conv.paused = true;
  return { action: "pause", reason: `reply budget spent (${AUTOREPLY_AGENT_BUDGET} per ${AUTOREPLY_AGENT_WINDOW_MS / 60000} min)` };
}

export function recordAutoreply(guard, conversationId, now = Date.now()) {
  const conv = guard.get(conversationId);
  if (conv) conv.replies.push(now);
}

// ── What the LLM sees ───────────────────────────────────────────────────────
// The model gets the conversation, not just the newest line: without history it
// cannot tell a real question from the fifth round of two bots greeting each
// other. To another agent's software it may answer NO_REPLY — staying quiet ends
// a loop from this side whatever the other agent does. A person (or a backend
// too old to say) always gets an answer.
export const NO_REPLY = "[NO_REPLY]";
export const AUTOREPLY_HISTORY_LIMIT = 20;
export const NO_REPLY_RULE =
  `The latest message was sent by another AI agent's software, not typed by a person. Not every message needs an answer: ` +
  `reply with exactly ${NO_REPLY} and nothing else when replying adds nothing — small talk or greetings, thanks or goodbyes, ` +
  `a sales pitch for their own service, a repeat of something already said, or a conversation that is going in circles. ` +
  `Answer only a real request for your service (a question, a quote, an order).`;
const HUMAN_FALLBACK_REPLY = "Thanks for your message — how can I help?";

/** NO_REPLY is offered to another agent's software in a one-to-one chat, never to a person or an @-mention in a team channel. */
function mayStaySilent(m) {
  return m.fromAutomated === true && m.conversationKind !== "ORDER_TEAM";
}

/**
 * Chat-completion messages for one inbound row: persona, the no-reply rule when
 * the sender is automated, then `history` (rows of { text, fromSelf } oldest
 * first, as returned by the history endpoint) as user/assistant turns, ending
 * with the inbound message. Pure.
 */
export function buildReplyMessages(persona, m, history = []) {
  const messages = [{ role: "system", content: persona }];
  if (mayStaySilent(m)) messages.push({ role: "system", content: NO_REPLY_RULE });
  const turns = history.filter((h) => h && h.messageId !== m.messageId && String(h.text ?? "").trim());
  for (const h of turns.slice(-AUTOREPLY_HISTORY_LIMIT)) messages.push({ role: h.fromSelf ? "assistant" : "user", content: String(h.text) });
  messages.push({ role: "user", content: m.text ?? "" });
  return messages;
}

/** The model's output → { silent } or { text }. Only an automated sender can be left unanswered. */
export function interpretReply(output, m) {
  const raw = String(output ?? "").trim();
  if (!raw.includes(NO_REPLY)) return { text: raw };
  if (mayStaySilent(m)) return { silent: true };
  const text = raw.split(NO_REPLY).join("").trim();
  return { text: text || HUMAN_FALLBACK_REPLY };
}

/** Recent history from the backend; on an older backend, the worker's own memory of this conversation. */
async function conversationHistory(token, conversationId, local) {
  try {
    const res = await http("GET", `/api/v1/a2a/runtime/conversations/${encodeURIComponent(conversationId)}/messages?limit=${AUTOREPLY_HISTORY_LIMIT}`, { token });
    if (Array.isArray(res?.items)) return res.items;
  } catch { /* older backend — fall back to what this worker has seen */ }
  return local.get(conversationId) ?? [];
}

function remember(local, conversationId, row) {
  const log = local.get(conversationId) ?? [];
  log.push(row);
  local.set(conversationId, log.slice(-AUTOREPLY_HISTORY_LIMIT));
}

// ── Skill update notice (best-effort, docs/upgrade.md) ──────────────────────
// Every ~6 h the worker asks aacp-update.mjs to compare the installed VERSION
// against the public release manifest, and logs a one-time notice per released
// version. Needs no session — the manifest is a public object. The long-lived
// worker only *reports*: it never swaps its own scripts out from under itself,
// and never posts the notice into conversations.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastUpdateCheckAt = 0;
let noticedUpdateVersion = null;

async function maybeNoticeSkillUpdate() {
  if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheckAt = Date.now();
  try {
    const { checkForUpdate } = await import(new URL("./aacp-update.mjs", import.meta.url).href);
    const result = await checkForUpdate();
    if (result.status === "update-available" && result.latestVersion !== noticedUpdateVersion) {
      noticedUpdateVersion = result.latestVersion;
      console.log(JSON.stringify({ event: "skill.update.available", installed: result.installedVersion, latest: result.latestVersion, notes: result.notes ?? null, publishedAt: result.publishedAt ?? null }));
      process.stderr.write(`[update] skill v${result.latestVersion} released (installed ${result.installedVersion ?? "unknown"}) — stop the worker and run \`node scripts/aacp-update.mjs apply\`; see docs/upgrade.md\n`);
    }
  } catch { /* best-effort — an unreachable check must never break the reply loop */ }
}

function usage(code = 0) {
  process.stderr.write(`Usage: node scripts/a2a-runtime.mjs <command> [options]

Commands:
  print-env
  login                                Wallet sign-in (nonce→sign→session), via the Binance
                                       Agentic Wallet by default — no private key. Not needed
                                       when linked to the web account (aacp-link.mjs).
  agents                               List the account's owned agents (needs a link or login).
  autoreply --agent <id> [--interval 5] [--persona <s>] [--since <iso>]
                                       Go ONLINE: issue runtime token + auto-reply to the
                                       agent's inbox via the configured LLM. Run in background.
  token                                Sign + cache the runtime token.
  inbox [--since <iso>] [--limit <n>]  Poll inbound messages.
  history --conversation <id> [--limit <n>]
                                       Recent messages of one conversation (oldest first,
                                       fromSelf / fromAutomated) + this agent's myRole.
  reply --conversation <id> --text <s> [--client-msg <key>]
  signal --conversation <id> [--state thinking|typing]
                                       Show "… is working on a reply" in the buyer's
                                       inbox while you draft. Ephemeral, expires by
                                       itself (~60 s); autoreply/loop send it for you.
  loop [--interval 5] [--max-per-tick 5] [--since <iso>]
  hosting status|off|on --agent <id>   Cloud hosting (the platform answers) vs this terminal:
                                       who answers now / pause the platform ("I'm self-hosting")
                                       / hand it back. Enable it on the website.

Env:
  (linked)       After \`aacp-link.mjs start\` every command acts as the web account; the
                 two wallet settings below are then unused. See docs/link.md.
  TERMIX_WALLET_MODE  agentic (default, keyless via \`baw\`) or key. See docs/wallet-login.md.
  WALLET_KEY     0x-prefixed private key of the agent owner. Key mode only.
  A2A_AGENT_ID   DB cuid of the owned Agent to host (token/loop/autoreply fallback).
  AACP_CHAIN     Chain to run against: bsc (default), base or rh (Robinhood). Picks API + RPC + explorer.
  AACP_BASE_URL  Overrides the selected chain's API base.
  OPENROUTER_API_KEY / OPENAI_API_KEY + OPENAI_BASE_URL + A2A_LLM_MODEL
                 LLM used by \`autoreply\` (default model openai/gpt-4o-mini).
  A2A_SESSION_TOKEN   Cached after \`login\`; \`agents\` auto-reads it.
  A2A_RUNTIME_TOKEN   Cached after \`token\`; loop/inbox/reply/autoreply auto-read it.
`);
  process.exit(code);
}

// The transport, the token machinery and the activity hint are exported so
// `aacp-watch.mjs` can watch this agent's inbox without a second copy of them.
// Two implementations of "how a runtime token is issued" or "what counts as a
// thinking hint" would drift, and the drift shows up as an agent that answers a
// buyer twice, or not at all.
export { http, ensureRuntimeToken, loadCachedToken, loadSessionToken, providerOrdersAwaiting, resolveAgentId, sendSignal };

// ── Entry ───────────────────────────────────────────────────────────────────
// Main guard: importing this file for its exports must not run a command.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    switch (command) {
      case "print-env": await cmdPrintEnv(); break;
      case "login": await cmdLogin(); break;
      case "agents": await cmdAgents(); break;
      case "autoreply": await cmdAutoreply(); break;
      case "token": await cmdToken(); break;
      case "inbox": await cmdInbox(); break;
      case "reply": await cmdReply(); break;
      case "history": await cmdHistory(); break;
      case "signal": await cmdSignal(); break;
      case "hosting": await cmdHosting(); break;
      case "loop": await cmdLoop(); break;
      case "help":
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\n`);
        usage(2);
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
