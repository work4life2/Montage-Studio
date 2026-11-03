#!/usr/bin/env node
//
// Termix Quant — provider-side helper (docs/quant-provider.md).
//
// A quant strategy is run by an agent that trades a CLIENT's money from a
// wallet the client alone can empty. The client hands over a session key by
// ENCRYPTING it to this agent's X25519 public key; the platform stores only
// ciphertext and has no decryption path. Everything here exists to serve that:
// publish the public half, pull the sealed envelopes, open them locally.
//
// Usage:
//   node aacp-quant.mjs register-key   --agent <agentId>
//   node aacp-quant.mjs key            --agent <agentId>
//   node aacp-quant.mjs strategies
//   node aacp-quant.mjs apply-template --agent <agentId> [--out <file>]
//   node aacp-quant.mjs apply          [--config <file>] [--confirm]
//   node aacp-quant.mjs inbox          --agent <agentId> [--open]
//   node aacp-quant.mjs accept         --agent <agentId> --job <quantJobId> [--yes]
//   node aacp-quant.mjs job            --job <quantJobId>
//   node aacp-quant.mjs trades         --job <quantJobId>
//   node aacp-quant.mjs trade          --job <quantJobId> --agent <agentId> --side buy|sell --amount <human>
//   node aacp-quant.mjs autotrade      --job <quantJobId> --agent <agentId> <start|once|status|stop> [--dry-run] [--confirm] [--no-auto-deliver]
//   node aacp-quant.mjs report         --job <quantJobId> --notes '<json>' | --from-state [--yes]
//
// Auth — identity order linked › agentic › key (SKILL.md rule 5). Every command
// uses the active identity's session: the web-account link, else the agentic
// wallet session from `a2a-runtime.mjs login`, else (explicit key mode only)
// an automatic login from WALLET_KEY. The X25519 keypair behind `register-key`
// / `inbox --open` is routed the same way (quant-provider-enc-key.mjs).
//
// Env: AACP_CHAIN (only `bsc`), AACP_BASE_URL, A2A_SESSION_TOKEN; key mode adds
// TERMIX_WALLET_MODE=key + WALLET_KEY.
//
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { activeChain, assertQuantSupported, resolveApiBaseUrl, resolveRpcUrl } from "./aacp-chain.mjs";
import { activeIdentity, loadSessionToken } from "./aacp-credentials.mjs";
import { ensureSession } from "./aacp-session.mjs";
import { resolveEncKeypair, deriveEncKeypairFresh } from "./quant-provider-enc-key.mjs";
import { llmConfigured, llmDiagnose, llmJson } from "./aacp-llm.mjs";
import {
  bumpCounter,
  counterFor,
  loadPolicy,
  loadState,
  logFilePath,
  policyExists,
  policyPath,
  requireNumber,
  requireOneOf,
  requireStringArray,
  requireText,
  saveState,
  stopWorker,
  workerStatus,
  writePid,
  writePolicy,
} from "./aacp-policy.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function requireArg(name) {
  const v = arg(name);
  if (!v || v === true) throw new Error(`--${name} is required`);
  return String(v);
}

async function api(method, path, body) {
  // Prefer the active identity's session (linked API key, or the agentic/key
  // wallet session cached by `a2a-runtime login`). Fall back to auto-logging in
  // from WALLET_KEY (key mode) so a bare `register-key` still works with just the
  // owner wallet's key set.
  const token = loadSessionToken() ?? (await ensureSession());
  const res = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const message = json?.error?.message ?? json?.message ?? text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}: ${message}`);
  }
  return json;
}

// ── X25519, derived from the wallet key ──────────────────────────────────────
//
// Deterministic on purpose: the agent can be reinstalled, moved to another
// machine or restarted and it re-derives the SAME key, so envelopes sealed
// yesterday still open. There is nothing extra to back up, and nothing extra
// to leak. The wallet key never leaves this process.
//
// The scheme is fixed by the client side (the browser seals with exactly this):
//   priv  = HKDF-SHA256(walletKey, info="termix-quant-x25519-v1", 32 bytes)
//   shared = X25519(ephemeral_priv, agent_pub)
//   key   = HKDF-SHA256(shared, salt=ephemeral_pub, info="termix-quant-envelope-v1", 32)
//   ChaCha20-Poly1305(key, nonce) over the serialized session
// Changing any label here silently breaks decryption for every client.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ALGORITHM = "x25519-hkdf-chacha20poly1305";

const privFromSeed = (seed32) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed32]), format: "der", type: "pkcs8" });
const pubFromRaw = (raw32) =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw32]), format: "der", type: "spki" });
const rawOf = (key) => key.export({ type: "spki", format: "der" }).subarray(-32);

// The provider's X25519 keypair now comes from resolveEncKeypair() (quant-provider-
// enc-key.mjs), which routes by identity: key → WALLET_KEY (unchanged), agentic/link
// → deterministic-signature-derived + locally cached. The X25519 SPKI/PKCS8 helpers
// above are still used by openEnvelope / sealForSelfTest.

function openEnvelope(priv, envelope) {
  const ephemeral = Buffer.from(envelope.ephemeralPublicKey, "base64");
  const shared = diffieHellman({ privateKey: priv, publicKey: pubFromRaw(ephemeral) });
  const key = Buffer.from(hkdfSync("sha256", shared, ephemeral, Buffer.from("termix-quant-envelope-v1"), 32));
  const blob = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("chacha20-poly1305", key, Buffer.from(envelope.nonce, "base64"), { authTagLength: 16 });
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString("utf8");
}

// Kept so a self-test can prove this file's seal and open still agree with the
// client's. Not used by any command.
export function sealForSelfTest(recipientRaw, plaintext) {
  const eph = privFromSeed(Buffer.from(hkdfSync("sha256", Buffer.from("self-test"), Buffer.alloc(0), Buffer.from("x"), 32)));
  const ephPub = rawOf(createPublicKey(eph));
  const shared = diffieHellman({ privateKey: eph, publicKey: pubFromRaw(recipientRaw) });
  const key = Buffer.from(hkdfSync("sha256", shared, ephPub, Buffer.from("termix-quant-envelope-v1"), 32));
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ephemeralPublicKey: ephPub.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"),
    algorithm: ALGORITHM,
  };
}

// ── chain constants ──────────────────────────────────────────────────────────
//
// Read live from `GET /api/v1/config/contracts`, never hardcoded here.
//
// The backend already publishes these per chain (its `quant` block — see
// packages/backend/src/services/contracts-config.ts), and they are exactly the
// values that must NOT be guessed: a wrong address sends a client's money to a
// contract that does not exist on this network. Taking them from the same
// backend that will settle the job also means the two can never disagree, and a
// chain the platform has not configured yet simply comes back null and is
// refused below instead of silently falling back to another chain's addresses.
//
// THE SHAPE. The block is structured, not flat:
//
//   { chainId, token: {address, symbol, decimals}, native: {symbol},
//     tradableTokens: [{address, symbol, decimals}],
//     venueAllowlist: [{label, address, kind: "venue" | "token"}],
//     syntheticLiquidity }
//
// This function used to read `quant.pancakeRouter` / `quant.paymentToken` /
// `quant.wbnb`. Those fields have never existed on any deployment, so every
// `trade` refused with "the quant vertical is not deployed on chain N" on
// testnet and mainnet alike — the skill could receive a session and then never
// act on it. The flat names are still accepted below so this keeps working if a
// backend ever publishes them.
//
// The Altana network name is the one thing the backend does not carry; the SDK
// accepts exactly two, keyed by chain id.
const ALTANA_NETWORKS = { 56: "bnb-mainnet", 97: "bnb-testnet" };

async function resolveQuantChain() {
  // The chain id comes from the registry, not from a private default: this file
  // used to fall back to 97, which on a mainnet build meant the rest of the skill
  // ran on 56 while every trade here assumed testnet.
  const chainId = Number(process.env.AACP_CHAIN_ID ?? activeChain().chainId);
  const altanaNetwork = ALTANA_NETWORKS[chainId];
  if (!altanaNetwork) {
    throw new Error(`The quant vertical has no Altana network for chain ${chainId} (expected 56 or 97).`);
  }

  const config = await api("GET", "/api/v1/config/contracts");
  const quant = config?.quant ?? {};
  const router = quant.venueAllowlist?.find((v) => v.kind === "venue")?.address ?? quant.pancakeRouter ?? null;
  const uToken = quant.token?.address ?? quant.paymentToken ?? null;
  const uDecimals = Number(quant.token?.decimals ?? 18);

  // The platform curates WHICH tokens a strategy may trade, and each row says
  // how it is priced. `priceRoute: "via_wbnb"` means there is no direct token/U
  // pool, so a swap has to hop through WBNB — routing it direct would simply
  // revert. WBNB itself is always present and always direct.
  const tokens = (quant.tradableTokens ?? [])
    .filter((t) => t?.address)
    .map((t) => ({
      address: t.address,
      symbol: t.symbol ?? "?",
      decimals: Number(t.decimals ?? 18),
      priceRoute: t.priceRoute === "via_wbnb" ? "via_wbnb" : "direct",
    }));
  // The hop token for `via_wbnb` routes. Identified by symbol rather than
  // position: `tradableTokens[0]` used to be assumed to BE wbnb, which stopped
  // being true the moment the registry could return several tokens.
  const wbnb = tokens.find((t) => t.symbol.toUpperCase() === "WBNB")?.address ?? quant.wbnb ?? null;

  if (!router || !uToken || !tokens.length) {
    const missing = [!router && "venue router", !uToken && "settlement token", !tokens.length && "tradable tokens"].filter(Boolean);
    throw new Error(
      `The quant vertical is not deployed on chain ${chainId}: the backend's quant block has no ${missing.join(" / ")} ` +
        `configured. Nothing here will guess a DEX address — ask the operator to configure it, or run against ` +
        `a chain where it is deployed.`,
    );
  }

  // A mismatch means the backend and the RPC are on different networks: every
  // read would succeed while every swap landed somewhere else. Fix AACP_CHAIN /
  // AACP_BASE_URL rather than forcing AACP_CHAIN_ID.
  if (quant.chainId != null && Number(quant.chainId) !== chainId) {
    throw new Error(
      `Chain mismatch: this skill is on chain ${chainId}, but ${resolveApiBaseUrl()} serves quant on chain ${quant.chainId}.`,
    );
  }

  // Venus (Core Pool) lending config, read from the dedicated quant.venus block
  // (NOT inferred from venueAllowlist, where the comptroller shares kind "venue"
  // with the swap router). null when the platform has no Venus configured.
  const venus = quant.venus?.comptroller
    ? {
        comptroller: quant.venus.comptroller,
        markets: (quant.venus.markets ?? [])
          .filter((m) => m?.vToken && m?.underlying)
          .map((m) => ({
            vToken: m.vToken,
            underlying: m.underlying,
            symbol: m.symbol ?? "?",
            decimals: Number(m.decimals ?? 18),
            priceRoute: m.priceRoute === "direct" ? "direct" : "via_wbnb",
          })),
      }
    : null;

  return { chainId, rpcUrl: resolveRpcUrl(), altanaNetwork, router, uToken, uDecimals, wbnb, tokens, venueAllowlist: quant.venueAllowlist ?? [], venus };
}

// Resolve a Venus market by vToken address or underlying symbol, from the
// platform-curated quant.venus.markets. Throws a clear error rather than let a
// typo become an on-chain call to the wrong contract.
export function resolveVenusMarket(chain, ref) {
  if (!chain.venus) throw new Error("Venus lending is not configured for this chain (quant.venus is empty).");
  const needle = String(ref).trim().toLowerCase();
  const m = chain.venus.markets.find((x) => x.vToken.toLowerCase() === needle || x.symbol.toLowerCase() === needle || x.underlying.toLowerCase() === needle);
  if (!m) throw new Error(`No Venus market for "${ref}". Configured: ${chain.venus.markets.map((x) => x.symbol).join(", ") || "(none)"}.`);
  return m;
}

/**
 * The swap path for a token, honouring its `priceRoute`.
 *
 * A `via_wbnb` token has no direct U pool; quoting or swapping it against U
 * directly reverts. Getting this wrong is invisible until a real trade fails.
 */
export function swapPath(chain, token, side) {
  const needsHop = token.priceRoute === "via_wbnb"
    && chain.wbnb
    && token.address.toLowerCase() !== chain.wbnb.toLowerCase();
  const buyLegs = needsHop ? [chain.uToken, chain.wbnb, token.address] : [chain.uToken, token.address];
  return side === "buy" ? buyLegs : [...buyLegs].reverse();
}

/**
 * Resolve `--token` (symbol or address) against what the platform curates AND
 * what this particular job's strategy chose.
 *
 * The job's `tokenAllowlist` is the narrower of the two and is what the client's
 * on-chain session actually authorises, so a token outside it would revert even
 * though the platform lists it.
 */
export function resolveTradableToken(chain, ref, jobTokenAllowlist) {
  const allowed = Array.isArray(jobTokenAllowlist) && jobTokenAllowlist.length
    ? new Set(jobTokenAllowlist.map((a) => String(a).toLowerCase()))
    : null;
  const inJob = (t) => !allowed || allowed.has(t.address.toLowerCase());
  const tradable = chain.tokens.filter(inJob);
  if (!tradable.length) {
    throw new Error("This job's strategy allows no tradable token that the platform still lists.");
  }
  if (!ref) {
    // Default to WBNB when the job allows it — it is the one token every
    // deployment has — otherwise the job's first allowed token.
    return tradable.find((t) => t.symbol.toUpperCase() === "WBNB") ?? tradable[0];
  }
  const needle = String(ref).toLowerCase();
  const match = chain.tokens.find((t) => t.symbol.toLowerCase() === needle || t.address.toLowerCase() === needle);
  if (!match) {
    throw new Error(`Unknown token ${ref}. This deployment trades: ${chain.tokens.map((t) => t.symbol).join(", ")}.`);
  }
  if (!inJob(match)) {
    throw new Error(
      `${match.symbol} is not in this job's tokenAllowlist, so the client's session would reject the call. ` +
        `Allowed here: ${tradable.map((t) => t.symbol).join(", ")}.`,
    );
  }
  return match;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdRegisterKey() {
  const agentId = requireArg("agent");

  // --verify (agentic): the published key MUST be reproducible, or in-flight client
  // sessions become undecryptable. Derive twice straight from the wallet signature
  // (bypassing the cache) and refuse to publish if the two disagree. link (web EOA)
  // is deterministic by spec; key mode re-derives from WALLET_KEY — neither needs it.
  if (Boolean(arg("verify")) && activeIdentity() !== "linked") {
    const a = (await deriveEncKeypairFresh()).pubRaw.toString("base64");
    const b = (await deriveEncKeypairFresh()).pubRaw.toString("base64");
    if (a !== b) {
      console.error(JSON.stringify({ verify: "FAIL", error: "The wallet produced two different encryption keys for the same message. Do NOT register — clients' sessions would become undecryptable." }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ verify: "PASS", encryptionPublicKey: a }, null, 2));
    return;
  }

  const { pubRaw } = await resolveEncKeypair();
  const encryptionPublicKey = pubRaw.toString("base64");
  const res = await api("POST", "/api/v1/quant/agent-key", { agentId, encryptionPublicKey, algorithm: ALGORITHM });
  console.log(JSON.stringify({
    status: "registered",
    agentId: res.agentId,
    encryptionPublicKey: res.encryptionPublicKey,
    algorithm: res.algorithm,
    note: "PUBLIC half only. The private half is re-derived on demand (key: from WALLET_KEY; agentic/link: from a cached signature-derived seed) and is never sent anywhere.",
  }, null, 2));
}

async function cmdKey() {
  const agentId = requireArg("agent");
  const res = await api("GET", `/api/v1/quant/agent-key?agentId=${encodeURIComponent(agentId)}`);
  console.log(JSON.stringify({
    agentId: res.agentId,
    registered: Boolean(res.encryptionPublicKey),
    encryptionPublicKey: res.encryptionPublicKey,
    algorithm: res.algorithm,
  }, null, 2));
}

async function cmdStrategies() {
  const res = await api("GET", "/api/v1/quant/my-strategies");
  const items = (res.items ?? []).map((s) => ({
    strategyId: s.id,
    name: s.name,
    status: s.status,
    providerAgentId: s.providerAgentId,
    encryptionKeyRegistered: s.encryptionKeyRegistered,
    activeJobs: s.activeJobs,
    realizedPnlU: s.realizedPnlU,
    tradeCount: s.tradeCount,
  }));
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
}

async function cmdInbox() {
  const agentId = requireArg("agent");
  const open = Boolean(arg("open"));
  const res = await api("GET", `/api/v1/quant/inbox?agentId=${encodeURIComponent(agentId)}`);
  const priv = open ? (await resolveEncKeypair()).priv : null;
  const items = (res.items ?? []).map((e) => {
    const row = { envelopeId: e.id, quantJobId: e.quantJobId, algorithm: e.algorithm, createdAt: e.createdAt };
    if (!open) return row;
    try {
      // Decrypt to PROVE the envelope is readable by this agent, and report
      // nothing but that. The plaintext is a serialized Altana session that
      // embeds a private key spending someone else's money: it must never be
      // printed, logged or written. `trade` re-opens it in memory when it
      // actually needs it. Interpreting it here would also drag the Altana SDK
      // into a script the whole skill keeps dependency-free on purpose.
      const plaintext = openEnvelope(priv, e);
      return { ...row, opened: true, sessionBytes: plaintext.length };
    } catch (err) {
      return { ...row, opened: false, error: `could not open: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
  // Funded fee orders this agent has not accepted yet. Their envelopes are
  // withheld until it does: see cmdAccept.
  const awaitingAccept = (res.awaitingAccept ?? []).map((a) => ({
    ...a,
    next: `node scripts/aacp-quant.mjs accept --agent ${agentId} --job ${a.quantJobId} --yes`,
  }));
  console.log(JSON.stringify({ count: items.length, items, awaitingAccept }, null, 2));
}

// Run aacp-tx.mjs for one intent. stderr (preview/progress) streams to the
// user; the final JSON on stdout is captured for the tx hash.
function runTxIntent(intent, { yes, context }) {
  return new Promise((res, rej) => {
    const argv = [resolve(SCRIPT_DIR, "aacp-tx.mjs"), "--intent", JSON.stringify(intent), ...(yes ? ["--yes"] : []), ...(context ? ["--context", JSON.stringify(context)] : [])];
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", rej);
    child.on("exit", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { /* preview-only or malformed */ }
      if (code !== 0) return rej(new Error(`aacp-tx.mjs exited ${code}${out.trim() ? `: ${out.trim()}` : ""}`));
      res(parsed ?? { output: out.trim() });
    });
  });
}

/**
 * Accept a job's management-fee order on-chain (TermixEscrow.acceptOrder).
 *
 * This IS picking the job up. The client's fee sits in escrow as a Pending
 * order, and while it is Pending the client can cancel it and take the fee
 * back at any time. So the platform withholds the session envelope until the
 * order is accepted: after this transaction the fee can no longer be pulled
 * back, and `inbox` starts returning the envelope once the backend has
 * indexed it (usually within a minute). Accepting locks the strategy's usual
 * provider-stake share of the fee, like any other order.
 */
async function cmdAccept() {
  const agentId = requireArg("agent");
  const jobId = requireArg("job");
  const res = await api("GET", `/api/v1/quant/inbox?agentId=${encodeURIComponent(agentId)}`);
  if ((res.items ?? []).some((e) => e.quantJobId === jobId)) {
    console.log(JSON.stringify({ status: "already-accepted", quantJobId: jobId }, null, 2));
    return;
  }
  const pending = (res.awaitingAccept ?? []).find((a) => a.quantJobId === jobId);
  if (!pending) {
    throw new Error(`Job ${jobId} has no fee order waiting for acceptance. The client may not have paid the fee yet, the job may have ended, or the accept is still being indexed — check \`inbox\` again shortly.`);
  }
  const intent = await api("POST", `/api/v1/orders/${encodeURIComponent(pending.orderId)}/provider-accept/prepare`, {});
  const result = await runTxIntent(intent, { yes: args.includes("--yes"), context: { orderId: pending.orderId } });
  console.log(JSON.stringify({
    status: args.includes("--yes") || activeIdentity() === "linked" ? "accepted" : "simulated",
    quantJobId: jobId,
    orderId: pending.orderId,
    chainOrderId: pending.chainOrderId,
    tx: result,
    next: "Poll `inbox --open` until the envelope appears, then trade.",
  }, null, 2));
}

async function cmdJob() {
  const id = requireArg("job");
  const job = await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(id)}`);
  console.log(JSON.stringify({
    quantJobId: job.id,
    status: job.status,
    strategyId: job.strategyId,
    tradingWalletAddress: job.tradingWalletAddress,
    allocationU: job.allocationU,
    dailyCapU: job.dailyCapU,
    termDays: job.termDays,
    startedAt: job.startedAt,
    endsAt: job.endsAt,
    sessionExpiresAt: job.sessionExpiresAt,
    revokedAt: job.revokedAt,
    venues: job.venues,
    realizedPnlU: job.realizedPnlU,
    tradeCount: job.tradeCount,
  }, null, 2));
}

async function cmdTrades() {
  const id = requireArg("job");
  const res = await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(id)}/trades`);
  const items = (res.items ?? []).map((t) => ({
    txHash: t.txHash,
    blockTime: t.blockTime,
    direction: t.direction,
    amountIn: t.amountIn,
    amountOut: t.amountOut,
    realizedPnlU: t.realizedPnlU,
    note: t.note,
  }));
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
}

async function cmdReport() {
  const id = requireArg("job");
  let trades;

  if (args.includes("--from-state")) {
    // The reasons `autotrade` recorded at decision time, replayed as the
    // end-of-term note. Written when the trade was made rather than
    // reconstructed afterwards, which is the whole point: a note invented at
    // term end from the chain history is a rationalisation, and voters reading
    // it next to the trades can usually tell.
    trades = recordedNotes(loadState(QUANT_STATE_FILE), id);
    if (!trades.length) {
      throw new Error(
        `No recorded trade reasons for job ${id} in ${QUANT_STATE_FILE}. ` +
          `Trades made outside \`autotrade\` have no stored rationale — pass --notes instead.`,
      );
    }
  } else {
    const raw = requireArg("notes");
    try {
      trades = JSON.parse(raw);
    } catch {
      throw new Error('--notes must be JSON: [{"txHash":"0x…","note":"why this trade"}]');
    }
  }
  if (!Array.isArray(trades)) throw new Error("--notes must be a JSON array.");
  trades = trades.map((t) => ({ ...t, note: String(t?.note ?? "").slice(0, QUANT_NOTE_MAX) }));
  console.log(JSON.stringify(await submitReport(id, trades, { yes: args.includes("--yes") }), null, 2));
}

/**
 * Post the report, then deliver the fee order on-chain with it.
 *
 * The report is the fee order's delivery: once the order was accepted, the
 * backend answers with a submitDelivery intent whose hash commits to these
 * notes. Broadcasting it is how the fee gets paid: it opens the client's
 * challenge window, after which the escrow releases. Skipping it leaves the
 * order FUNDED until its deadline (the term plus a few days of grace), after
 * which anyone can cancelExpired it back to the client. Re-reporting the same
 * notes re-uses the same intent, so retrying is safe.
 */
async function submitReport(jobId, trades, { yes }) {
  const res = await api("POST", `/api/v1/quant/jobs/${encodeURIComponent(jobId)}/report`, { trades });
  const out = { status: res.status, notesApplied: res.notesApplied, delivery: null };
  if (!res.deliveryIntent) {
    out.delivery = "none: the fee order is not accepted, or was already delivered";
    return out;
  }
  const { orderId, ...intent } = res.deliveryIntent;
  const tx = await runTxIntent(intent, { yes, context: { orderId } });
  out.delivery = { orderId, broadcast: yes || activeIdentity() === "linked", tx };
  if (!out.delivery.broadcast) out.next = "Simulated only. Re-run with --yes to deliver the fee order on-chain.";
  return out;
}

/** The reasons `autotrade` recorded at decision time, as report notes. */
function recordedNotes(state, jobId) {
  return (state.jobs?.[jobId]?.trades ?? [])
    .filter((t) => t.txHash && t.reason)
    .map((t) => ({ txHash: t.txHash, note: String(t.reason).slice(0, QUANT_NOTE_MAX) }));
}

// ── trading ──────────────────────────────────────────────────────────────────
//
// The session is only worth having if the agent can act on it, and until this
// existed the skill could receive a session and then do nothing with it.
//
// Execution is RELAY-shaped, not signer-shaped: the client's task wallet was
// upgraded in place by EIP-7702, so a trade is an `execute` against the Altana
// relay signed by the session key — not a transaction sent from the agent's own
// wallet. The agent never holds the client's funds and never pays their gas.
//
// The on-chain account enforces the session's own limits (which contracts, how
// much per day, expiry). A call outside them REVERTS; it does not silently
// succeed, so there is no need to re-check them here — but the error a user
// sees should say which limit bit, hence the explicit permission dump below.

const ROUTER_ABI = [
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Venus VBep20 (Core Pool). mint/redeemUnderlying/borrow/repayBorrow are the
// supply/withdraw/borrow/repay actions; balanceOfUnderlying/borrowBalanceStored
// are the read side used for sizing and PnL.
const VTOKEN_ABI = [
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "mintAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "redeemUnderlying", type: "function", stateMutability: "nonpayable", inputs: [{ name: "redeemAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "borrow", type: "function", stateMutability: "nonpayable", inputs: [{ name: "borrowAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "repayBorrow", type: "function", stateMutability: "nonpayable", inputs: [{ name: "repayAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOfUnderlying", type: "function", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "borrowBalanceStored", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];

const COMPTROLLER_ABI = [
  { name: "enterMarkets", type: "function", stateMutability: "nonpayable", inputs: [{ name: "vTokens", type: "address[]" }], outputs: [{ name: "", type: "uint256[]" }] },
  { name: "getAccountLiquidity", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "error", type: "uint256" }, { name: "liquidity", type: "uint256" }, { name: "shortfall", type: "uint256" }] },
];

// Decimals are per token (chain.uDecimals for U, token.decimals for the rest).
// There is deliberately no global constant: the registry can list an 8-decimal
// token, and assuming 18 would misprice it by 10^10.

/**
 * The serialized Altana session for a job, decrypted locally.
 *
 * The plaintext is exactly what the client's browser produced with
 * `serializeSession()` — an opaque string, NOT JSON. It embeds the session's
 * private key, so it is returned to the caller and never printed, logged or
 * written anywhere.
 */
async function serializedSessionForJob(jobId, agentId) {
  const res = await api("GET", `/api/v1/quant/inbox?agentId=${encodeURIComponent(agentId)}`);
  const envelope = (res.items ?? []).find((e) => e.quantJobId === jobId);
  if (!envelope) {
    if ((res.awaitingAccept ?? []).some((a) => a.quantJobId === jobId)) {
      throw new Error(`Job ${jobId}'s fee order is not accepted yet, so its session is withheld. Run \`node scripts/aacp-quant.mjs accept --agent ${agentId} --job ${jobId} --yes\` first.`);
    }
    throw new Error(`No session envelope for job ${jobId}. The client has not delivered one yet.`);
  }
  const { priv } = await resolveEncKeypair();
  return openEnvelope(priv, envelope);
}

/**
 * The ONLY part of this skill that needs npm packages.
 *
 * Every other command is deliberately dependency-free `.mjs` + built-in fetch,
 * which is what lets the skill run inside any agent runtime. Trading cannot be:
 * a 7702 session executes through the Altana relay with a signature scheme that
 * lives in the SDK, and reimplementing that over raw fetch would be a private
 * protocol reimplementation nobody could maintain.
 *
 * So it is loaded lazily, and a missing package produces an instruction rather
 * than a stack trace.
 */
/**
 * Import an npm package installed in the USER'S working directory.
 *
 * A bare `import("viem")` resolves from THIS file's location — inside the
 * installed skill directory — not from wherever the operator ran the command.
 * So the documented "install them in the agent's working directory, then
 * retry" never actually worked: the packages landed in ./node_modules and the
 * script kept looking beside itself.
 *
 * Resolving through a `createRequire` anchored at cwd makes that instruction
 * true. The plain import is kept as a fallback for the case where the skill
 * really does sit inside a tree that already has the dependency.
 */
async function importFromCwd(specifier) {
  try {
    const require = createRequire(resolve(process.cwd(), "noop.cjs"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch {
    return import(specifier);
  }
}

/**
 * Read-only chain access needs `viem` and nothing else.
 *
 * Split out from loadTradingDeps because looking at the price should not cost
 * three packages: `market` only reads balances and quotes, so it must not drag
 * in the two SDKs that exist purely to sign through the relay.
 */
async function loadViem() {
  try {
    return await importFromCwd("viem");
  } catch (err) {
    throw new Error(
      "Reading the market needs one package this skill does not bundle:\n" +
        `  cd ${process.cwd()} && npm i viem\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function loadTradingDeps() {
  try {
    const [viem, wallets] = await Promise.all([importFromCwd("viem"), importFromCwd("@bnbagent/sdk/wallets")]);
    // A bundler-invisible dynamic import inside the SDK reports the Altana peer
    // as "not installed" unless the importer is supplied explicitly.
    wallets.setAltanaSdkImporter(() => importFromCwd("@altananetwork/sdk"));
    return { viem, wallets };
  } catch (err) {
    throw new Error(
      "Trading needs three packages this skill does not bundle (everything else here is dependency-free).\n" +
        "Install them in the directory you run this from, then retry:\n" +
        `  cd ${process.cwd()} && npm i viem @bnbagent/sdk @altananetwork/sdk\n` +
        "Note @altananetwork/sdk is GPL-3.0-or-later and ESM-only.\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Everything needed to READ the market and check a trade against policy.
 *
 * Deliberately stops short of the client's session: reading balances and quotes
 * needs `viem` alone, so `market` — and every rejection path in `trade` — works
 * without the two SDKs that exist purely to sign through the relay.
 *
 * The chain is resolved FIRST so a chain where the vertical is not deployed
 * refuses immediately, rather than after an npm install the user turns out not
 * to need. Shared by `market`, `trade` and `autotrade`, so the three can never
 * drift into disagreeing about which router or which token they point at.
 */
async function openReadContext(jobId) {
  const chain = await resolveQuantChain();
  const viem = await loadViem();
  const job = await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(jobId)}`);
  const client = viem.createPublicClient({ transport: viem.http(chain.rpcUrl) });
  return { chain, viem, job, client };
}

/**
 * Add the client's session so the context can actually execute.
 *
 * This is the step that needs the SDKs and decrypts the envelope, so it runs
 * LAST — after liveness and policy have already had their chance to refuse.
 */
async function attachSession(ctx, agentId) {
  assertJobTradable(ctx.job);
  const { wallets } = await loadTradingDeps();
  const session = await wallets.deserializeSession(await serializedSessionForJob(ctx.job.id, agentId));
  ctx.provider = new wallets.AltanaWalletProvider({ session, network: ctx.chain.altanaNetwork });
  return ctx;
}

/**
 * Refuse to trade a session that is no longer live.
 *
 * The account enforces expiry on-chain too, so this is not the safety boundary
 * — it is the difference between a clear sentence and a bare revert. It matters
 * most to the unattended loop, which should stop rather than burn a tick every
 * fifteen minutes against a session the client revoked hours ago.
 */
function assertJobTradable(job) {
  if (job.revokedAt) throw new Error("The client revoked this session. Nothing further can be traded.");
  const now = Date.now();
  if (job.sessionExpiresAt && Date.parse(job.sessionExpiresAt) <= now) {
    throw new Error(`The session expired at ${job.sessionExpiresAt}. Only the client can grant a new one.`);
  }
  if (job.endsAt && Date.parse(job.endsAt) <= now) {
    throw new Error(`The term ended at ${job.endsAt}. What remains is the end-of-term report, not more trading.`);
  }
}

/**
 * Spot quote plus the slippage floor, without sending anything.
 *
 * Decimals are per token, not a global 18: a `buy` spends U (18) and receives
 * `token.decimals`, a `sell` does the reverse. Assuming 18 everywhere silently
 * misprices any 8-decimal token by 10^10.
 */
async function quoteSwap(ctx, side, token, amountHuman, slippagePct) {
  const { chain, viem, client } = ctx;
  const path = swapPath(chain, token, side);
  const inDecimals = side === "buy" ? chain.uDecimals : token.decimals;
  const outDecimals = side === "buy" ? token.decimals : chain.uDecimals;
  const amountIn = viem.parseUnits(String(amountHuman), inDecimals);
  const quoted = await client.readContract({
    address: chain.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  // The last leg is the output — with a via_wbnb hop the path has three entries.
  const expectedOut = quoted[quoted.length - 1];
  const minOut = (expectedOut * BigInt(Math.round((100 - slippagePct) * 100))) / BigInt(10_000);
  if (minOut <= BigInt(0)) throw new Error("The pool cannot fill this size. Trade smaller.");
  return { path, tokenIn: path[0], amountIn, expectedOut, minOut, inDecimals, outDecimals };
}

async function executeSwap(ctx, side, token, amountHuman, slippagePct) {
  const { chain, viem, job, provider } = ctx;
  const { path, tokenIn, amountIn, expectedOut, minOut, outDecimals } = await quoteSwap(ctx, side, token, amountHuman, slippagePct);

  // ONE atomic batch: approve THEN swap, in the same relay intent.
  //
  // Not a micro-optimisation — it is the only thing that works. The Altana
  // account leaves no standing ERC-20 allowance: it resets the approval to zero
  // at the end of the transaction that granted it (observed on chain: two
  // Approval events, `1` then `0`, in one tx). Sending approve and swap as two
  // separate executes therefore always leaves the swap facing a zero allowance,
  // which the router reports as the famously unhelpful
  // `TransferHelper: TRANSFER_FROM_FAILED`.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const result = await provider._relayExecute(
    [
      {
        to: tokenIn,
        data: viem.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [chain.router, amountIn] }),
      },
      {
        to: chain.router,
        data: viem.encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: "swapExactTokensForTokens",
          args: [amountIn, minOut, path, job.tradingWalletAddress, deadline],
        }),
      },
    ],
    `quant ${side} ${amountHuman} ${token.symbol}`,
  );

  return {
    status: "submitted",
    side,
    token: token.symbol,
    route: path.length > 2 ? "via WBNB" : "direct",
    amountIn: String(amountHuman),
    expectedOut: viem.formatUnits(expectedOut, outDecimals),
    minOut: viem.formatUnits(minOut, outDecimals),
    txHash: result?.transactionHash ?? null,
    callsId: result?.callsId ?? null,
  };
}

// ── Venus (Core Pool) lending execution ──────────────────────────────────────
// Additive to the swap path: same session executor (_relayExecute atomic batch),
// same "approve+use in one intent" rule (the Altana account zeroes allowances at
// tx end). A borrow is gated on comptroller health so the loop cannot dig itself
// into a liquidatable hole.

async function venusHealth(ctx) {
  const { chain, client, viem, job } = ctx;
  if (!chain.venus) throw new Error("Venus lending is not configured for this chain.");
  const [, liquidity, shortfall] = await client.readContract({
    address: chain.venus.comptroller, abi: COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [job.tradingWalletAddress],
  });
  return { liquidityU: Number(viem.formatUnits(liquidity, 18)), shortfallU: Number(viem.formatUnits(shortfall, 18)), healthy: shortfall === 0n };
}

async function executeVenusSupply(ctx, market, amountHuman) {
  const { viem, provider, chain } = ctx;
  const amount = viem.parseUnits(String(amountHuman), market.decimals);
  const result = await provider._relayExecute(
    [
      { to: market.underlying, data: viem.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [market.vToken, amount] }) },
      { to: market.vToken, data: viem.encodeFunctionData({ abi: VTOKEN_ABI, functionName: "mint", args: [amount] }) },
      { to: chain.venus.comptroller, data: viem.encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "enterMarkets", args: [[market.vToken]] }) },
    ],
    `venus supply ${amountHuman} ${market.symbol}`,
  );
  return { status: "submitted", action: "supply", market: market.symbol, amount: String(amountHuman), txHash: result?.transactionHash ?? null, callsId: result?.callsId ?? null };
}

async function executeVenusBorrow(ctx, market, amountHuman, minHeadroomU) {
  const { viem, provider } = ctx;
  const health = await venusHealth(ctx);
  if (!health.healthy) throw new Error(`Refusing to borrow: the account is already underwater (shortfall ${health.shortfallU} U).`);
  // Conservative: treat 1 unit of underlying as ~1 U of headroom drawn. For a
  // stablecoin market this is exact; for a volatile underlying it under-borrows,
  // which is the safe direction near a liquidation threshold.
  const borrowU = Number(amountHuman);
  const remaining = health.liquidityU - borrowU;
  if (remaining < minHeadroomU) {
    throw new Error(`Refusing to borrow ${amountHuman} ${market.symbol}: would leave ${remaining.toFixed(2)} U headroom, below the ${minHeadroomU} U floor (current ${health.liquidityU.toFixed(2)} U).`);
  }
  const amount = viem.parseUnits(String(amountHuman), market.decimals);
  const result = await provider._relayExecute(
    [{ to: market.vToken, data: viem.encodeFunctionData({ abi: VTOKEN_ABI, functionName: "borrow", args: [amount] }) }],
    `venus borrow ${amountHuman} ${market.symbol}`,
  );
  return { status: "submitted", action: "borrow", market: market.symbol, amount: String(amountHuman), headroomBeforeU: health.liquidityU, txHash: result?.transactionHash ?? null, callsId: result?.callsId ?? null };
}

async function executeVenusRepay(ctx, market, amountHuman) {
  const { viem, provider } = ctx;
  const amount = viem.parseUnits(String(amountHuman), market.decimals);
  const result = await provider._relayExecute(
    [
      { to: market.underlying, data: viem.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [market.vToken, amount] }) },
      { to: market.vToken, data: viem.encodeFunctionData({ abi: VTOKEN_ABI, functionName: "repayBorrow", args: [amount] }) },
    ],
    `venus repay ${amountHuman} ${market.symbol}`,
  );
  return { status: "submitted", action: "repay", market: market.symbol, amount: String(amountHuman), txHash: result?.transactionHash ?? null, callsId: result?.callsId ?? null };
}

async function executeVenusRedeem(ctx, market, amountHuman) {
  const { viem, provider } = ctx;
  const amount = viem.parseUnits(String(amountHuman), market.decimals);
  const result = await provider._relayExecute(
    [{ to: market.vToken, data: viem.encodeFunctionData({ abi: VTOKEN_ABI, functionName: "redeemUnderlying", args: [amount] }) }],
    `venus redeem ${amountHuman} ${market.symbol}`,
  );
  return { status: "submitted", action: "redeem", market: market.symbol, amount: String(amountHuman), txHash: result?.transactionHash ?? null, callsId: result?.callsId ?? null };
}

// Same-asset leverage fold: borrow a fraction of the current headroom and
// re-supply it, N rounds, checking health before each round. Stops early when
// headroom hits the floor. Cross-asset leverage (borrow X, swap to Y, supply Y)
// is intentionally NOT here — it adds swap slippage/price risk to a lending loop.
async function executeVenusLoop(ctx, market, rounds, ltvPct, minHeadroomU) {
  const steps = [];
  for (let i = 0; i < rounds; i++) {
    const health = await venusHealth(ctx);
    if (!health.healthy || health.liquidityU <= minHeadroomU) { steps.push({ round: i + 1, stopped: `headroom ${health.liquidityU.toFixed(2)} U at/below ${minHeadroomU} U floor` }); break; }
    const borrowU = (health.liquidityU - minHeadroomU) * (ltvPct / 100);
    if (borrowU < 0.01) { steps.push({ round: i + 1, stopped: "borrowable amount too small" }); break; }
    const amountStr = borrowU.toFixed(6);
    const b = await executeVenusBorrow(ctx, market, amountStr, minHeadroomU);
    const s = await executeVenusSupply(ctx, market, amountStr);
    steps.push({ round: i + 1, borrowedU: Number(amountStr), borrowTx: b.txHash, supplyTx: s.txHash });
  }
  return { status: "submitted", action: "loop", market: market.symbol, rounds: steps.length, steps, finalHealth: await venusHealth(ctx) };
}

async function cmdVenusState() {
  const jobId = requireArg("job");
  console.log(JSON.stringify(await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(jobId)}/venus`), null, 2));
}

async function runVenusAction(fn, buildArgs) {
  const jobId = requireArg("job");
  const agentId = requireArg("agent");
  const ctx = await openReadContext(jobId);
  const market = resolveVenusMarket(ctx.chain, requireArg("market"));
  await attachSession(ctx, agentId);
  console.log(JSON.stringify(await fn(ctx, market, ...buildArgs()), null, 2));
}

const cmdVenusSupply = () => runVenusAction(executeVenusSupply, () => [requireArg("amount")]);
const cmdVenusRepay = () => runVenusAction(executeVenusRepay, () => [requireArg("amount")]);
const cmdVenusRedeem = () => runVenusAction(executeVenusRedeem, () => [requireArg("amount")]);
const cmdVenusBorrow = () => runVenusAction(executeVenusBorrow, () => [requireArg("amount"), Number(arg("min-headroom") ?? 5)]);
const cmdVenusLoop = () => runVenusAction(executeVenusLoop, () => [Number(arg("rounds") ?? 3), Number(arg("ltv") ?? 50), Number(arg("min-headroom") ?? 5)]);

async function cmdTrade() {
  const jobId = requireArg("job");
  const agentId = requireArg("agent");
  const side = String(requireArg("side")).toLowerCase();
  if (side !== "buy" && side !== "sell") throw new Error("--side must be buy (U into the token) or sell (the token back into U)");
  const amountHuman = requireArg("amount");
  // Default 1%: this deployment's pool is thin, and a swap that moves the price
  // further than the client would expect should fail rather than fill.
  const slippagePct = Number(arg("slippage") ?? 1);

  const reason = typeof arg("reason") === "string" ? String(arg("reason")) : null;
  const ctx = await openReadContext(jobId);
  const state = loadState(QUANT_STATE_FILE);
  // Which token, checked against BOTH the platform registry and this job's own
  // allowlist — the latter is what the client's session actually authorises.
  const token = resolveTradableToken(ctx.chain, arg("token"), ctx.job.tokenAllowlist);

  // When a strategy policy exists, a hand-driven trade obeys the SAME caps the
  // unattended loop does. Otherwise "use the other command" would be a way to
  // spend past a daily limit the user set — the limit has to bind whoever is
  // deciding, model or agent or human.
  //
  // Checked BEFORE the session is attached, so a refusal costs the user nothing
  // and does not require the trading SDKs to be installed at all.
  if (policyExists(strategyFile()) && !args.includes("--ignore-policy")) {
    const policy = validateAutoTrade(loadPolicy(strategyFile()));
    const market = await readMarket(ctx);
    const focus = market.byToken[token.address.toLowerCase()];
    // Guardrails reason in U notional; a `sell` amount is given in the token.
    const amountU = side === "buy" ? Number(amountHuman) : Number(amountHuman) * (focus?.uPerToken ?? 0);
    const verdict = checkGuardrails(
      { action: side, amountU, token: token.symbol, reason: reason ?? "" },
      policy, market, ctx, state,
    );
    if (!verdict.trade) {
      throw new Error(`${verdict.reason}\nThis is the policy in ${policyPath(strategyFile())}. Pass --ignore-policy to override deliberately.`);
    }
  }

  await attachSession(ctx, agentId);
  const result = await executeSwap(ctx, side, token, amountHuman, slippagePct);

  // Record the rationale at decision time so `report --from-state` can replay it
  // at term end, rather than a story reconstructed from the chain afterwards.
  if (reason) {
    const row = jobStateFor(state, jobId);
    row.lastTradeAt = new Date().toISOString();
    row.trades.push({ at: row.lastTradeAt, side, token: token.symbol, amountU: Number(amountHuman), reason, txHash: result.txHash ?? null });
    bumpCounter(state, `quant-${jobId}`, { amount: side === "buy" ? Number(amountHuman) : 0 });
    saveState(QUANT_STATE_FILE, state);
  }

  console.log(JSON.stringify({
    ...result,
    reasonRecorded: Boolean(reason),
    note: "The platform's indexer reconstructs this swap within a few blocks; it then appears on the client's job page with its realized PnL."
      + (reason ? "" : " No --reason was given, so this trade will not appear in `report --from-state`."),
  }, null, 2));
}

// ── strategy configuration ───────────────────────────────────────────────────
//
// One file holds both halves of "configure my quant strategy":
//
//   * the LISTING TERMS the platform reviews (name, thesis, fees, capacity),
//     submitted by `apply`;
//   * the TRADING POLICY the unattended loop runs inside (per-trade size, daily
//     notional, trade count, spacing, slippage, position ceiling), enforced by
//     `autotrade`.
//
// They live together because they describe the same promise seen from two
// sides: what the client is told, and what the agent is actually allowed to do.

const DEFAULT_STRATEGY_FILE = "agent-mart-quant-strategy.json";
const QUANT_STATE_FILE = ".agent-mart-quant-state.json";
// The backend rejects the whole report if any note is longer (validators/api.ts).
const QUANT_NOTE_MAX = 1000;

const strategyFile = () => {
  const v = arg("config");
  return typeof v === "string" && v ? v : DEFAULT_STRATEGY_FILE;
};

function autotradeScope(jobId) {
  return `quant-autotrade-${jobId}`;
}

function defaultAutoTrade() {
  return {
    // OFF by default, and `autotrade start` additionally demands --confirm.
    // This loop spends a client's money without a human in the loop; it should
    // take two deliberate acts to switch on, not one forgotten default.
    enabled: false,
    intervalSeconds: 900,
    maxTradeU: "5",
    maxDailyNotionalU: "50",
    maxTradesPerDay: 6,
    minSecondsBetweenTrades: 600,
    slippagePct: 1,
    // Ceiling on how much of the allocation may sit in WBNB at once. The
    // remainder stays in U, so a bad call cannot take the whole book with it.
    maxPositionPctOfAllocation: 60,
    stopAfterConsecutiveFailures: 3,
  };
}

async function cmdApplyTemplate() {
  const agentId = requireArg("agent");
  const out = typeof arg("out") === "string" ? String(arg("out")) : strategyFile();
  if (policyExists(out) && !args.includes("--force")) {
    throw new Error(`${policyPath(out)} already exists. Edit it, or pass --force to overwrite.`);
  }

  // Addresses are never typed by hand: they become the session's on-chain call
  // list, and anything that is not exactly what this deployment curates is
  // rejected by the backend (fail-closed) or produces a session that can be
  // granted and then never executed. Read from the same source the browser
  // wizard reads.
  const config = await api("GET", "/api/v1/config/contracts");
  const quant = config?.quant ?? {};
  const uAddress = quant.token?.address ?? null;
  const curated = (quant.tradableTokens ?? []).filter((t) => t?.address);
  const venues = (quant.venueAllowlist ?? []).filter((v) => v.kind === "venue").map((v) => v.address);
  if (!venues.length || !uAddress || !curated.length) {
    throw new Error(
      `The quant vertical is not configured on this network (${resolveApiBaseUrl()}), so no session could be granted. ` +
        `Nothing here will guess a venue address.`,
    );
  }

  // WHICH tokens this strategy trades is the provider's choice — the platform
  // curates the menu, the provider narrows it. Default to all of them; `--tokens
  // BTCB,ETH` picks a subset.
  const wanted = typeof arg("tokens") === "string"
    ? String(arg("tokens")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;
  const chosen = wanted
    ? curated.filter((t) => wanted.includes(t.symbol.toLowerCase()) || wanted.includes(t.address.toLowerCase()))
    : curated;
  if (!chosen.length) {
    throw new Error(
      `None of --tokens matched. This deployment curates: ${curated.map((t) => t.symbol).join(", ")}.`,
    );
  }

  // The two lists mean different things, and swapping them is the mistake this
  // comment exists to prevent:
  //   tokenAllowlist — the tokens this strategy trades. NOT U; U is the
  //                    settlement currency, not something you trade into.
  //   venueAllowlist — every contract the session may call: the router, plus U
  //                    and each traded token (approve is called on each).
  const tokenAllowlist = chosen.map((t) => t.address);
  const venueAllowlist = [...venues, uAddress, ...tokenAllowlist];

  const path = writePolicy(out, {
    providerAgentId: agentId,
    name: "",
    thesis: "",
    methodology: "",
    riskTier: "medium",
    // One of QUANT_CATEGORIES; the backend requires it.
    category: "grid",
    capacityU: "1000",
    minAllocationU: "100",
    mgmtFeeBps: 200,
    termDaysOptions: [30],
    // Filled from the network's curated registry. Do not hand-edit addresses;
    // re-run apply-template with --tokens to change the selection.
    tokenAllowlist,
    venueAllowlist,
    autoTrade: defaultAutoTrade(),
  });

  console.log(JSON.stringify({
    status: "created",
    config: path,
    tradesTokens: chosen.map((t) => t.symbol),
    availableTokens: curated.map((t) => t.symbol),
    note: "Addresses come from this network's curated registry — do not hand-edit them. "
      + "Re-run with --tokens <symbols> to trade a different subset.",
    next: [
      "Fill name / thesis / methodology / fees, then preview with: node scripts/aacp-quant.mjs apply",
      "Nothing is submitted until you re-run it with --confirm.",
    ],
  }, null, 2));
}

// The backend's strategy categories (validators/api.ts quantCategory) and its
// per-strategy capacity ceiling (services/quant.ts QUANT_MAX_STRATEGY_CAPACITY_U).
const QUANT_CATEGORIES = ["yield", "grid", "rebalancing", "health_factor"];
const QUANT_MAX_CAPACITY_U = 1000;

// Mirrors the browser wizard's validation (packages/frontend/app/quant/apply)
// so a submission from here fails for the same reasons, with the same wording,
// rather than bouncing off the backend with a schema error.
function validateApplication(raw) {
  const mgmtFeeBps = requireNumber(raw.mgmtFeeBps, "mgmtFeeBps", { min: 0, max: 300, integer: true });
  const termDaysOptions = raw.termDaysOptions;
  if (!Array.isArray(termDaysOptions) || termDaysOptions.length === 0) {
    throw new Error("termDaysOptions must list at least one term, e.g. [30].");
  }
  return {
    providerAgentId: requireText(raw.providerAgentId, "providerAgentId", { max: 120 }),
    name: requireText(raw.name, "name", { max: 120 }),
    // 140 characters is the wizard's limit, and it is a real one: the thesis is
    // the first line a buyer reads on the strategy card.
    thesis: requireText(raw.thesis, "thesis", { max: 140 }),
    methodology: requireText(raw.methodology, "methodology", { max: 8000 }),
    riskTier: requireOneOf(raw.riskTier, "riskTier", ["low", "medium", "high"]),
    category: requireOneOf(raw.category, "category", QUANT_CATEGORIES),
    venueAllowlist: requireStringArray(raw.venueAllowlist ?? [], "venueAllowlist", { max: 20, maxLength: 120 }),
    // The tokens this strategy TRADES. A list holding only the settlement
    // currency is the legacy single-pair shape: the client's session would be
    // authorised for U and nothing else, so no swap could ever execute.
    // Regenerating the template is the fix, not editing this by hand.
    tokenAllowlist: requireStringArray(raw.tokenAllowlist ?? [], "tokenAllowlist", { max: 50, maxLength: 120 }),
    capacityU: String(requireNumber(raw.capacityU, "capacityU", { min: 10, max: QUANT_MAX_CAPACITY_U })),
    minAllocationU: String(requireNumber(raw.minAllocationU, "minAllocationU", { min: 10 })),
    mgmtFeeBps,
    // Whole days, or 0.25 for the 6-hour term (the backend accepts nothing else).
    termDaysOptions: termDaysOptions.map((d, i) =>
      Number(d) === 0.25 ? 0.25 : requireNumber(d, `termDaysOptions[${i}]`, { min: 1, max: 3650, integer: true }),
    ),
  };
}

async function cmdApply() {
  const file = strategyFile();
  const raw = loadPolicy(file, { hint: "Create one with: node scripts/aacp-quant.mjs apply-template --agent <agentId>" });
  const body = validateApplication(raw);
  if (!body.venueAllowlist.length || !body.tokenAllowlist.length) {
    throw new Error("venueAllowlist / tokenAllowlist are empty. Regenerate the file with apply-template so they come from the network.");
  }
  // Catch the legacy single-pair shape before the backend does. A strategy whose
  // tokenAllowlist is just the settlement currency grants a session that can
  // hold U and trade nothing.
  const settlement = (await api("GET", "/api/v1/config/contracts"))?.quant?.token?.address;
  if (settlement && body.tokenAllowlist.every((a) => a.toLowerCase() === settlement.toLowerCase())) {
    throw new Error(
      "tokenAllowlist contains only the settlement currency (U), so this strategy could not trade anything. "
        + "It should list the tokens you intend to TRADE. Regenerate with: aacp-quant.mjs apply-template --agent "
        + `${body.providerAgentId} --force`,
    );
  }

  // An application from an agent with no published X25519 key is dead on
  // arrival: no client can seal a session to it, so it would be reviewed and
  // listed and then silently receive nothing.
  const key = await api("GET", `/api/v1/quant/agent-key?agentId=${encodeURIComponent(body.providerAgentId)}`);
  if (!key?.encryptionPublicKey) {
    throw new Error(
      `Agent ${body.providerAgentId} has not published its encryption key, so no client could hand it a session. ` +
        `Run: node scripts/aacp-quant.mjs register-key --agent ${body.providerAgentId}`,
    );
  }

  const terms = {
    strategy: body.name,
    riskTier: body.riskTier,
    category: body.category,
    managementFee: `${(body.mgmtFeeBps / 100).toFixed(2)}% of the allocation per year, charged pro rata for the term`,
    capacity: `${body.capacityU} U total across all clients`,
    minimumAllocation: `${body.minAllocationU} U per client`,
    terms: body.termDaysOptions.map((d) => (d === 0.25 ? "6 hours" : `${d} days`)),
    venue: "PancakeSwap V2 spot only, U ↔ WBNB. No leverage, no shorting.",
  };

  if (!args.includes("--confirm")) {
    // These are the USER'S commercial terms and their public promise, not an
    // implementation detail — so the default is to show them the exact thing
    // that would be submitted and stop. Agreeing on their behalf is the one
    // thing this command must not do.
    console.log(JSON.stringify({
      status: "preview",
      config: policyPath(file),
      terms,
      payload: body,
      submit: "Show the terms above to the user. Only after they agree, re-run with --confirm.",
    }, null, 2));
    return;
  }

  const res = await api("POST", "/api/v1/quant/applications", body);
  console.log(JSON.stringify({
    status: "submitted",
    strategyId: res?.id ?? null,
    reviewStatus: res?.status ?? "PENDING_REVIEW",
    terms,
    note: "Track the review with: node scripts/aacp-quant.mjs strategies",
    // Said to the user now, unprompted (docs/quant-provider.md has the full
    // wording). The provider cannot fund a job against their own strategy —
    // the backend rejects it — so the first CLIENT job is what activates it.
    tellUser: [
      "The strategy is in review and takes no jobs until it is approved.",
      "Once approved it is public on the Quant page under \"Not yet active\", where clients can fund a job against it.",
      "It becomes active, with a track record on its card, once the platform indexes the first on-chain trade from a client's job. You cannot fund that first job yourself — a job against your own strategy is rejected — so keep this agent running and its key registered.",
    ],
  }, null, 2));
}

function validateAutoTrade(raw) {
  const a = raw.autoTrade ?? {};
  const maxTradeU = requireNumber(a.maxTradeU, "autoTrade.maxTradeU", { min: 0 });
  const maxDailyNotionalU = requireNumber(a.maxDailyNotionalU, "autoTrade.maxDailyNotionalU", { min: 0 });
  if (maxDailyNotionalU < maxTradeU) throw new Error("autoTrade.maxDailyNotionalU must be at least autoTrade.maxTradeU.");
  return {
    enabled: a.enabled === true,
    intervalSeconds: requireNumber(a.intervalSeconds ?? 900, "autoTrade.intervalSeconds", { min: 60, max: 86_400, integer: true }),
    maxTradeU,
    maxDailyNotionalU,
    maxTradesPerDay: requireNumber(a.maxTradesPerDay ?? 6, "autoTrade.maxTradesPerDay", { min: 0, max: 500, integer: true }),
    minSecondsBetweenTrades: requireNumber(a.minSecondsBetweenTrades ?? 600, "autoTrade.minSecondsBetweenTrades", { min: 0, max: 86_400, integer: true }),
    slippagePct: requireNumber(a.slippagePct ?? 1, "autoTrade.slippagePct", { min: 0.01, max: 50 }),
    maxPositionPctOfAllocation: requireNumber(a.maxPositionPctOfAllocation ?? 60, "autoTrade.maxPositionPctOfAllocation", { min: 0, max: 100 }),
    stopAfterConsecutiveFailures: requireNumber(a.stopAfterConsecutiveFailures ?? 3, "autoTrade.stopAfterConsecutiveFailures", { min: 1, max: 100, integer: true }),
  };
}

/** What one unit of a token fetches in U, as a plain number. Prices, never trades. */
async function spotUPerToken(ctx, token) {
  const { chain, viem, client } = ctx;
  const quoted = await client.readContract({
    address: chain.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [viem.parseUnits("1", token.decimals), swapPath(chain, token, "sell")],
  });
  return Number(viem.formatUnits(quoted[quoted.length - 1], chain.uDecimals));
}

/**
 * What the wallet actually holds, and what the pool actually pays, per token.
 *
 * Balances come from the chain, never from local bookkeeping: the client can
 * top up or withdraw from their own wallet at any time, and a loop sizing
 * trades off a remembered number would eventually size them off a fiction.
 *
 * Scoped to the tokens THIS job's strategy chose, because those are the only
 * ones its on-chain session can touch — pricing the rest would be noise the
 * agent might act on.
 */
async function readMarket(ctx) {
  const { chain, viem, client, job } = ctx;
  const wallet = job.tradingWalletAddress;
  const allowed = Array.isArray(job.tokenAllowlist) && job.tokenAllowlist.length
    ? new Set(job.tokenAllowlist.map((a) => String(a).toLowerCase()))
    : null;
  const tokens = chain.tokens.filter((t) => !allowed || allowed.has(t.address.toLowerCase()));
  const balanceOf = (address) =>
    client.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });

  const [uRaw, ...perToken] = await Promise.all([
    balanceOf(chain.uToken),
    ...tokens.map(async (t) => {
      // One unpriceable token must not blind the whole book.
      const [raw, uPerToken] = await Promise.all([
        balanceOf(t.address),
        spotUPerToken(ctx, t).catch(() => null),
      ]);
      const balance = Number(viem.formatUnits(raw, t.decimals));
      return {
        symbol: t.symbol,
        address: t.address,
        decimals: t.decimals,
        priceRoute: t.priceRoute,
        balance,
        uPerToken,
        valueU: uPerToken == null ? null : balance * uPerToken,
      };
    }),
  ]);

  const uBalance = Number(viem.formatUnits(uRaw, chain.uDecimals));
  const byToken = Object.fromEntries(perToken.map((t) => [t.address.toLowerCase(), t]));
  return {
    uBalance,
    tokens: perToken,
    byToken,
    // Total position in U across every held token, so it can be compared
    // against the allocation and the caps without juggling units.
    positionU: perToken.reduce((sum, t) => sum + (t.valueU ?? 0), 0),
  };
}

/** {SYMBOL: uPerToken} — the per-tick price record the series is built from. */
function priceSnapshot(market) {
  return Object.fromEntries(market.tokens.filter((t) => t.uPerToken != null).map((t) => [t.symbol, t.uPerToken]));
}

const TRADE_DECISION_SHAPE = `{
  "action": "buy" | "sell" | "hold",
  "token": "<symbol of the token to trade; omit when holding>",
  "amountU": "<notional in U; 0 when holding>",
  "reason": "<one or two sentences the client will read at term end>"
}`;

async function decideTrade(ctx, policy, market, history) {
  const { job } = ctx;
  const symbols = market.tokens.map((t) => t.symbol).join(", ") || "(none)";
  const system =
    "You manage a small spot book for a client on BNB Chain, settled in U (a stablecoin), PancakeSwap V2 only. " +
    `This strategy may trade exactly these tokens: ${symbols}. Nothing else — the client's on-chain session ` +
    "rejects any other contract.\n" +
    "No leverage, no shorting, no stop-loss exists. Holding is the correct answer most of the time — you are " +
    "judged on realized PnL reconstructed from the chain, and churn is a guaranteed loss to fees and slippage. " +
    "Your reason will be shown to the client verbatim at term end and read by voters if they dispute, so say " +
    "what you actually think, including when you are wrong.\n" +
    `Hard limits (a larger request is refused, not scaled): at most ${policy.maxTradeU} U per trade, ` +
    `${policy.maxDailyNotionalU} U and ${policy.maxTradesPerDay} trades per day, and at most ` +
    `${policy.maxPositionPctOfAllocation}% of the allocation held in tokens.`;
  const holdings = market.tokens
    .map((t) => `${t.symbol}: ${t.balance} (1 ${t.symbol} = ${t.uPerToken ?? "unpriceable"} U)`)
    .join("; ") || "(none)";
  const user =
    `Allocation: ${job.allocationU} U. Term ends ${job.endsAt ?? "unknown"}.\n` +
    `Wallet now: ${market.uBalance} U. Holdings: ${holdings}. Total position ≈ ${market.positionU.toFixed(4)} U.\n` +
    `Recent prices (oldest→newest): ${history.prices.map((p) => JSON.stringify(p.byToken ?? p.uPerWbnb)).join(" | ") || "(none yet)"}\n` +
    `Your recent trades: ${history.trades.length ? JSON.stringify(history.trades.slice(-5)) : "(none yet)"}\n` +
    `Decide: buy (U into a token), sell (a token back into U), or hold. Name the token by symbol.`;
  return llmJson({ system, user, schemaHint: TRADE_DECISION_SHAPE });
}

/**
 * Every limit, checked against the model's answer.
 *
 * A breach becomes a HOLD with a stated reason, never a scaled-down trade: the
 * numbers in the policy file are the ones the user approved, and quietly
 * trading a smaller size than asked still trades a size nobody chose.
 */
function checkGuardrails(decision, policy, market, ctx, state) {
  const action = String(decision?.action ?? "hold").toLowerCase();
  if (action === "hold") return { trade: false, reason: decision?.reason ? `hold: ${decision.reason}` : "hold" };
  if (action !== "buy" && action !== "sell") return { trade: false, reason: `refused: unknown action ${JSON.stringify(decision?.action)}` };

  const amountU = Number(decision?.amountU);
  if (!Number.isFinite(amountU) || amountU <= 0) return { trade: false, reason: `refused: amountU ${JSON.stringify(decision?.amountU)} is not a positive number` };
  if (amountU > policy.maxTradeU) return { trade: false, reason: `refused: ${amountU} U exceeds maxTradeU ${policy.maxTradeU}` };

  const counter = counterFor(state, `quant-${ctx.job.id}`);
  if (policy.maxTradesPerDay > 0 && counter.count >= policy.maxTradesPerDay) {
    return { trade: false, reason: `refused: ${counter.count} trades already today (maxTradesPerDay ${policy.maxTradesPerDay})` };
  }
  if (counter.amount + amountU > policy.maxDailyNotionalU) {
    return { trade: false, reason: `refused: ${counter.amount.toFixed(2)} + ${amountU} U would exceed maxDailyNotionalU ${policy.maxDailyNotionalU}` };
  }

  const jobState = state.jobs?.[ctx.job.id];
  if (jobState?.lastTradeAt && policy.minSecondsBetweenTrades > 0) {
    const waited = (Date.now() - Date.parse(jobState.lastTradeAt)) / 1000;
    if (waited < policy.minSecondsBetweenTrades) {
      return { trade: false, reason: `refused: last trade was ${Math.round(waited)}s ago (minSecondsBetweenTrades ${policy.minSecondsBetweenTrades})` };
    }
  }

  // Which token. The decision names it by symbol; it must be one this job's
  // strategy actually chose, because that list is what the client's on-chain
  // session authorises — anything else reverts.
  const held = market.tokens ?? [];
  const wanted = decision?.token ? String(decision.token).toLowerCase() : null;
  const focus = wanted
    ? held.find((t) => t.symbol.toLowerCase() === wanted || t.address.toLowerCase() === wanted)
    : held.find((t) => t.symbol.toUpperCase() === "WBNB") ?? held[0];
  if (!focus) {
    return {
      trade: false,
      reason: `refused: ${decision?.token ? `token ${JSON.stringify(decision.token)} is not tradable by this job` : "this job has no tradable token"}`
        + (held.length ? ` (allowed: ${held.map((t) => t.symbol).join(", ")})` : ""),
    };
  }

  if (action === "buy") {
    if (market.uBalance < amountU) return { trade: false, reason: `refused: wallet holds ${market.uBalance} U, needs ${amountU}` };
    const allocation = Number(ctx.job.allocationU);
    if (Number.isFinite(allocation) && allocation > 0) {
      const ceiling = (allocation * policy.maxPositionPctOfAllocation) / 100;
      if (market.positionU + amountU > ceiling) {
        return { trade: false, reason: `refused: position would reach ${(market.positionU + amountU).toFixed(2)} U, over the ${policy.maxPositionPctOfAllocation}% ceiling (${ceiling.toFixed(2)} U)` };
      }
    }
    return { trade: true, side: "buy", token: focus.symbol, amount: String(amountU), amountU, reason: decision.reason ?? "" };
  }

  // Sell: the model reasons in U, the swap spends the token. Convert at the
  // live quote and never ask for more than the wallet actually holds.
  if (!(focus.uPerToken > 0)) return { trade: false, reason: `refused: no usable ${focus.symbol} price` };
  const amountToken = amountU / focus.uPerToken;
  if (amountToken > focus.balance) {
    return { trade: false, reason: `refused: selling ${amountU} U of ${focus.symbol} needs ${amountToken.toFixed(8)}, wallet holds ${focus.balance}` };
  }
  // Round to the token's own precision: more decimals than it has would be
  // rejected by parseUnits at the moment of the trade.
  return {
    trade: true,
    side: "sell",
    token: focus.symbol,
    amount: amountToken.toFixed(Math.min(focus.decimals, 12)),
    amountU,
    reason: decision.reason ?? "",
  };
}

function jobStateFor(state, jobId) {
  const jobs = state.jobs ?? (state.jobs = {});
  const row = jobs[jobId] ?? (jobs[jobId] = { prices: [], trades: [], lastTradeAt: null, consecutiveFailures: 0 });
  if (!Array.isArray(row.prices)) row.prices = [];
  if (!Array.isArray(row.trades)) row.trades = [];
  return row;
}

async function autotradeTick(jobId, agentId, policy, state, { dryRun }) {
  // Read-only until a trade is actually authorised: a tick that ends in `hold`
  // — which is most of them — never decrypts the client's session.
  const ctx = await openReadContext(jobId);
  assertJobTradable(ctx.job);
  const market = await readMarket(ctx);
  const row = jobStateFor(state, jobId);

  // This deployment has NO price feed. The series the loop reasons over is the
  // one it builds here, quote by quote — which is also why it is capped: a
  // window, not a ledger.
  row.prices.push({ at: new Date().toISOString(), byToken: priceSnapshot(market) });
  if (row.prices.length > 96) row.prices = row.prices.slice(-96);
  saveState(QUANT_STATE_FILE, state);

  const decision = await decideTrade(ctx, policy, market, row);
  const verdict = checkGuardrails(decision, policy, market, ctx, state);
  if (!verdict.trade) {
    return { event: "quant.hold", jobId, reason: verdict.reason, prices: priceSnapshot(market), positionU: Number(market.positionU.toFixed(4)) };
  }

  if (dryRun) {
    return { event: "quant.would_trade", jobId, side: verdict.side, amount: verdict.amount, amountU: verdict.amountU, reason: verdict.reason, posted: false };
  }

  await attachSession(ctx, agentId);
  const tradeToken = resolveTradableToken(ctx.chain, verdict.token, ctx.job.tokenAllowlist);
  const result = await executeSwap(ctx, verdict.side, tradeToken, verdict.amount, policy.slippagePct);
  row.lastTradeAt = new Date().toISOString();
  row.trades.push({ at: row.lastTradeAt, side: verdict.side, token: verdict.token, amountU: verdict.amountU, reason: verdict.reason, txHash: result.txHash ?? null });
  bumpCounter(state, `quant-${jobId}`, { amount: verdict.amountU });
  saveState(QUANT_STATE_FILE, state);
  return { event: "quant.trade", jobId, ...result, amountU: verdict.amountU, reason: verdict.reason };
}

/**
 * Everything needed to DECIDE a trade, without opening the client's envelope.
 *
 * This is the agent-driven half of the quant loop: the host agent reads this,
 * thinks, and then calls `trade --reason …`. No model runs inside the script,
 * so no API key is involved.
 */
async function cmdMarket() {
  const jobId = requireArg("job");
  const chain = await resolveQuantChain();
  const viem = await loadViem();
  const job = await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(jobId)}`);

  const client = viem.createPublicClient({ transport: viem.http(chain.rpcUrl) });
  const ctx = { chain, viem, client, job };
  const market = await readMarket(ctx);

  const state = loadState(QUANT_STATE_FILE);
  const row = jobStateFor(state, jobId);
  // Record the quote even on a read: this series IS the price history — the
  // deployment has no feed — so every look at the market should thicken it.
  row.prices.push({ at: new Date().toISOString(), byToken: priceSnapshot(market) });
  if (row.prices.length > 96) row.prices = row.prices.slice(-96);
  saveState(QUANT_STATE_FILE, state);

  // Report the limits only when the user actually has a policy file; a manual
  // operator without one should not be told about caps that do not exist.
  let limits = null;
  if (policyExists(strategyFile())) {
    const policy = validateAutoTrade(loadPolicy(strategyFile()));
    const counter = counterFor(state, `quant-${jobId}`);
    const allocation = Number(job.allocationU);
    limits = {
      maxTradeU: policy.maxTradeU,
      dailyNotionalRemainingU: Math.max(0, policy.maxDailyNotionalU - counter.amount),
      tradesRemainingToday: policy.maxTradesPerDay > 0 ? Math.max(0, policy.maxTradesPerDay - counter.count) : null,
      minSecondsBetweenTrades: policy.minSecondsBetweenTrades,
      secondsSinceLastTrade: row.lastTradeAt ? Math.round((Date.now() - Date.parse(row.lastTradeAt)) / 1000) : null,
      positionCeilingU: Number.isFinite(allocation) ? (allocation * policy.maxPositionPctOfAllocation) / 100 : null,
      slippagePct: policy.slippagePct,
    };
  }

  let liveness = "tradable";
  try {
    assertJobTradable(job);
  } catch (err) {
    liveness = err instanceof Error ? err.message : String(err);
  }

  console.log(JSON.stringify({
    quantJobId: jobId,
    liveness,
    allocationU: job.allocationU,
    termEndsAt: job.endsAt ?? null,
    sessionExpiresAt: job.sessionExpiresAt ?? null,
    wallet: {
      address: job.tradingWalletAddress,
      uBalance: market.uBalance,
      positionU: Number(market.positionU.toFixed(6)),
    },
    // Only the tokens this job's strategy chose: the rest cannot be traded by
    // its session, so pricing them would be noise.
    tokens: market.tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      balance: t.balance,
      uPerToken: t.uPerToken,
      valueU: t.valueU == null ? null : Number(t.valueU.toFixed(6)),
      route: t.priceRoute === "via_wbnb" ? "via WBNB" : "direct",
    })),
    recentPrices: row.prices.slice(-24).map((p) => p.byToken ?? p.uPerWbnb),
    recentTrades: row.trades.slice(-5),
    limits,
    howToAct: [
      "Buy:  aacp-quant.mjs trade --job <id> --agent <id> --side buy  --amount <U>    --reason <why>",
      "Sell: aacp-quant.mjs trade --job <id> --agent <id> --side sell --amount <WBNB> --reason <why>",
      "--amount is in the token being SPENT. Holding is usually correct; churn loses to fees.",
    ],
  }, null, 2));
}

/**
 * What a stopping worker does about the delivery. By default it reports the
 * recorded reasons and broadcasts the delivery (without it the provider is never
 * paid); started with --no-auto-deliver it only prints the command. A failed
 * delivery prints the command too.
 */
async function deliverOnStop(jobId, state, autoDeliver) {
  const next = `node scripts/aacp-quant.mjs report --job ${jobId} --from-state --yes`;
  if (!autoDeliver) return { event: "quant.delivery_due", jobId, next };
  try {
    return { event: "quant.delivered", jobId, ...(await submitReport(jobId, recordedNotes(state, jobId), { yes: true })) };
  } catch (err) {
    return { event: "quant.delivery_failed", jobId, error: err instanceof Error ? err.message : String(err), next };
  }
}

async function cmdAutotrade() {
  const jobId = requireArg("job");
  const sub = ["start", "once", "status", "stop"].find((s) => args.includes(s)) ?? "status";
  const scope = autotradeScope(jobId);

  if (sub === "status") {
    console.log(JSON.stringify(workerStatus(scope), null, 2));
    return;
  }
  if (sub === "stop") {
    console.log(JSON.stringify(stopWorker(scope), null, 2));
    return;
  }

  const agentId = requireArg("agent");
  const file = strategyFile();
  const policy = validateAutoTrade(loadPolicy(file, { hint: "Create one with: node scripts/aacp-quant.mjs apply-template --agent <agentId>" }));
  const dryRun = args.includes("--dry-run");
  const isWorker = args.includes("--worker");
  // Opt-in: the user authorises it at start, with the exposure, like the trading.
  // On by default: an undelivered fee order pays the provider nothing and is refundable after its deadline.
  const autoDeliver = !args.includes("--no-auto-deliver");
  const state = loadState(QUANT_STATE_FILE);

  if (sub === "once") {
    if (!dryRun && !policy.enabled) throw new Error(`autoTrade.enabled is false in ${policyPath(file)}. Set it to true, or pass --dry-run.`);
    if (!llmConfigured()) throw new Error("No LLM key — set OPENROUTER_API_KEY or OPENAI_API_KEY. The loop decides with a model.");
    console.log(JSON.stringify(await autotradeTick(jobId, agentId, policy, state, { dryRun }), null, 2));
    return;
  }

  // ── start ────────────────────────────────────────────────────────────────
  if (!isWorker) {
    if (!policy.enabled) throw new Error(`autoTrade.enabled is false in ${policyPath(file)}. Set it to true to run unattended.`);
    if (!args.includes("--confirm")) {
      // The user authorises the POLICY, once, not each broadcast — an
      // unattended loop cannot ask. So the full exposure gets read back before
      // anything starts, and the loop then stays inside it.
      const job = await api("GET", `/api/v1/quant/jobs/${encodeURIComponent(jobId)}`);
      console.log(JSON.stringify({
        status: "confirmation-required",
        jobId,
        allocationU: job.allocationU,
        termEndsAt: job.endsAt ?? null,
        sessionExpiresAt: job.sessionExpiresAt ?? null,
        exposure: {
          perTrade: `at most ${policy.maxTradeU} U`,
          perDay: `at most ${policy.maxDailyNotionalU} U across at most ${policy.maxTradesPerDay} trades`,
          spacing: `at least ${policy.minSecondsBetweenTrades}s between trades`,
          positionCeiling: `at most ${policy.maxPositionPctOfAllocation}% of the allocation in WBNB`,
          slippage: `${policy.slippagePct}%`,
          decidesEvery: `${policy.intervalSeconds}s`,
        },
        autoDeliver: autoDeliver
          ? "ON: when the job is over (term ended, revoked or expired) the worker reports the recorded reasons and broadcasts the fee order's on-chain delivery itself, without asking."
          : "off (--no-auto-deliver): when the job is over the worker stops and prints the report command; the fee is only paid once you run it.",
        warning:
          "This trades a CLIENT'S money with no per-trade confirmation. Read the exposure above back to the user, " +
          "then re-run with --confirm only if they agree.",
      }, null, 2));
      return;
    }
    const existing = workerStatus(scope);
    if (existing.status === "online") {
      console.log(JSON.stringify({ status: "already-online", ...existing }));
      return;
    }
    if (!loadSessionToken()) await ensureSession();
    if (!llmConfigured()) throw new Error("No LLM key — set OPENROUTER_API_KEY or OPENAI_API_KEY before going online.");
    // Prove the whole path works BEFORE detaching: chain resolved, packages
    // present, envelope opens, session live. Each of those failing inside a
    // forked worker is a silent no-op the operator would read as "running".
    // This is the one place that attaches the session eagerly, precisely
    // because "it will fail on the first trade, hours from now" is not an
    // acceptable way to find out.
    await attachSession(await openReadContext(jobId), agentId);

    const logFile = logFilePath(scope);
    const fd = openSync(logFile, "a");
    const childArgs = [fileURLToPath(import.meta.url), "autotrade", "start", "--worker", "--confirm", "--job", jobId, "--agent", agentId, "--config", file, ...(autoDeliver ? [] : ["--no-auto-deliver"])];
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    writePid(scope, child.pid);
    child.unref();
    console.log(JSON.stringify({ status: "online", jobId, pid: child.pid, interval: policy.intervalSeconds, log: logFile }, null, 2));
    return;
  }

  // ── worker ───────────────────────────────────────────────────────────────
  writePid(scope, process.pid);
  process.stderr.write(`[autotrade] ONLINE job=${jobId} interval=${policy.intervalSeconds}s maxTrade=${policy.maxTradeU}U daily=${policy.maxDailyNotionalU}U\n`);
  const cleanup = () => { saveState(QUANT_STATE_FILE, state); stopWorker(scope); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    const row = jobStateFor(state, jobId);
    try {
      const result = await autotradeTick(jobId, agentId, policy, state, { dryRun: false });
      row.consecutiveFailures = 0;
      console.log(JSON.stringify(result));
    } catch (err) {
      row.consecutiveFailures = (row.consecutiveFailures ?? 0) + 1;
      const message = err instanceof Error ? err.message : String(err);
      // A revoked session, an expired term or an exhausted allowance is not a
      // transient blip — retrying it every interval for days would be noise
      // over someone else's account. Stop and say why.
      const terminal = /revoked|expired|term ended/i.test(message);
      process.stderr.write(`[autotrade] tick failed (${row.consecutiveFailures}): ${await llmDiagnose(err, `quant autotrade job ${jobId}`)}\n`);
      if (terminal || row.consecutiveFailures >= policy.stopAfterConsecutiveFailures) {
        console.log(JSON.stringify({ event: "quant.stopped", jobId, reason: message, failures: row.consecutiveFailures }));
        // A job that is really over still owes its delivery (a revoked one too:
        // the fee pays for the term). Only a job that is over: a run of
        // transient failures may still be fixed and resumed within the term.
        if (terminal) console.log(JSON.stringify(await deliverOnStop(jobId, state, autoDeliver)));
        saveState(QUANT_STATE_FILE, state);
        stopWorker(scope);
        process.exit(terminal ? 0 : 1);
      }
      saveState(QUANT_STATE_FILE, state);
    }
    await new Promise((r) => setTimeout(r, policy.intervalSeconds * 1000));
  }
}

const COMMANDS = {
  "register-key": cmdRegisterKey,
  key: cmdKey,
  strategies: cmdStrategies,
  "apply-template": cmdApplyTemplate,
  apply: cmdApply,
  inbox: cmdInbox,
  accept: cmdAccept,
  job: cmdJob,
  trades: cmdTrades,
  report: cmdReport,
  // Agent-driven: `market` shows what you need to decide, `trade --reason`
  // records why. Neither runs a model, so neither needs an API key.
  market: cmdMarket,
  trade: cmdTrade,
  // Unattended: needs an LLM key, because a detached worker cannot reach the
  // host agent's model.
  autotrade: cmdAutotrade,
  // Venus (Core Pool) lending: supply/borrow/repay/redeem + a same-asset leverage
  // fold, all through the same session executor. `venus-state` is read-only.
  "venus-state": cmdVenusState,
  "venus-supply": cmdVenusSupply,
  "venus-borrow": cmdVenusBorrow,
  "venus-repay": cmdVenusRepay,
  "venus-redeem": cmdVenusRedeem,
  "venus-loop": cmdVenusLoop,
};

// The guardrails and the job-liveness check are exported so a self-test can
// drive every refusal branch without a live client session. They are pure —
// `checkGuardrails` decides nothing on its own, it only says whether the
// model's answer is inside the policy. Nothing below imports them.
export { assertJobTradable, checkGuardrails, validateApplication, validateAutoTrade };

// Running the CLI on import would make this file impossible to test and would
// fire on any `import` for its exports. Same main-guard as aacp-update.mjs.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const run = COMMANDS[cmd];
  if (!run) {
    console.error(`Usage: node aacp-quant.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`);
    process.exit(1);
  }
  // One gate for EVERY command, before any network call. The read-only and
  // API-only commands need it as much as the trading ones: on a chain without
  // the vertical they would otherwise reach a backend that has no quant, and
  // `register-key` would quietly succeed at publishing a key nobody can use.
  try {
    assertQuantSupported();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
