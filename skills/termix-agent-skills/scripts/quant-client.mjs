#!/usr/bin/env node
//
// Termix Quant — CLIENT-side "接单" (job creation) flow.
//
// Ports the browser wizard (packages/frontend/app/quant/new) so an AI can take a
// quant job from the terminal — no raw private key. The per-job task wallet is
// HD-derived from ONE signature; its LOCAL derived key signs the EIP-7702 upgrade +
// Altana session grant; the login wallet pays the principal transfer + fee escrow.
// The backend never sees a private key and only records addresses.
//
// The derivation signature comes from the active identity:
//   agentic  — the Binance Agentic Wallet signs an EIP-712 message (own wallet set).
//              BSC mainnet only (agentic cannot sign on testnets).
//   link     — the browser web wallet personal_signs via a MESSAGE sign-request
//              (`/sign?id=`); derives the SAME task wallets as the website. Works on
//              any chain the web wallet supports, including testnets.
//
// Order (each real-money step is its own subcommand, preview-first):
//   login (once)   node scripts/a2a-runtime.mjs login  (agentic) | aacp-link.mjs start (link)
//   client-strategy --strategy <id>                            # inspect (no money)
//   derive [--verify]                                          # derive (agentic: determinism gate)
//   allocate       --strategy <id>                             # server-allocates HD index
//   register       --index <n>                                 # derive + register address
//   fund           --index <n> --allocationU <U> [--yes]       # $$ principal + gas
//   create --strategy <id> --index <n> --allocationU <U> --dailyCapU <U> --termDays <d>
//   deliver        --index <n> --job <id>                      # 7702 grant + seal + POST session
//   checkout       --job <id>                                  # open fee escrow
//   escrow-fee     --checkout <id> [--yes]                     # $$ approve + createOrder + confirm
//
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activeChain, assertQuantSupported, chainCacheFile, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, loadSessionToken } from "./aacp-credentials.mjs";
import { agenticAddress } from "./aacp-wallet.mjs";
import { signMessageViaBrowser } from "./aacp-sign-message.mjs";
import { estimateGas, getChainId, getFees, getNonce, rpc, sendRawTransaction, waitReceipt } from "./eth-rpc.mjs";
import { signTransaction } from "./vendor/eth-signer.mjs";
import {
  deriveTaskWallet,
  deriveTaskWalletAddress,
  deriveTaskWalletSeedFromSig,
  signDerivationMessage,
  wipeBytes,
} from "./quant-task-wallet.mjs";
import { deriveSeedFromWebSig } from "./quant-task-wallet-web.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];

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
const flag = (name) => arg(name) === true || arg(name) === "true";

// ── backend calls (agentic / linked session) ────────────────────────────────

async function clientApi(method, path, body) {
  const token = loadSessionToken();
  if (!token) {
    throw new Error(
      "No session for this backend. Sign in first:\n" +
        "  node scripts/a2a-runtime.mjs login   (agentic wallet)\n" +
        "  node scripts/aacp-link.mjs start     (web account)",
    );
  }
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
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const message = json?.error?.message ?? json?.message ?? String(text).slice(0, 300);
    const err = new Error(`${method} ${path} → ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── chain / venue config (live from the backend, never hardcoded) ────────────

async function resolveQuantChainClient() {
  const chainId = Number(activeChain().chainId);
  const config = await clientApi("GET", "/api/v1/config/contracts");
  const quant = config?.quant ?? {};
  if (quant.chainId != null && Number(quant.chainId) !== chainId) {
    throw new Error(`Chain mismatch: skill on ${chainId}, backend serves quant on ${quant.chainId}.`);
  }
  const uToken = quant.token?.address ?? quant.paymentToken ?? null;
  const uDecimals = Number(quant.token?.decimals ?? 18);
  const venueAllowlist = quant.venueAllowlist ?? [];
  const tokens = (quant.tradableTokens ?? [])
    .filter((t) => t?.address)
    .map((t) => ({ address: t.address, symbol: t.symbol ?? "?", decimals: Number(t.decimals ?? 18) }));
  if (!uToken || !tokens.length || !venueAllowlist.length) {
    throw new Error(`The quant vertical is not configured on ${resolveApiBaseUrl()} (chain ${chainId}).`);
  }
  return { chainId, uToken, uDecimals, venueAllowlist, tokens };
}

/**
 * The session's on-chain call allowlist + the tokens the agent may spend.
 * Port of quant-new-page.tsx:237-256. Fail-closed: the venue list must include
 * the router, U, AND each traded token (a swap's approve is a call to the token).
 */
function buildSessionAllowlist(chain, strategy) {
  const wanted = new Set((strategy?.tokenAllowlist ?? []).map((a) => String(a).toLowerCase()));
  let chosen = chain.tokens.filter((t) => wanted.has(t.address.toLowerCase()));
  if (chosen.length === 0) chosen = chain.tokens; // legacy strategies with no allowlist trade all curated tokens
  const routerVenues = chain.venueAllowlist.filter((v) => v.kind === "venue").map((v) => v.address);
  const marketVenues = chain.venueAllowlist.filter((v) => v.kind === "money-market").map((v) => v.address);
  if (routerVenues.length === 0 || chosen.length === 0) {
    throw new Error("The trading venue is not configured for this network yet.");
  }
  const seen = new Set();
  const venues = [];
  for (const addr of [...routerVenues, ...marketVenues, chain.uToken, ...chosen.map((t) => t.address)]) {
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    venues.push(addr);
  }
  return { venues, tradableTokens: chosen.map((t) => ({ address: t.address, symbol: t.symbol })) };
}

// ── on-chain deps (viem + Altana SDK, installed in cwd — same as trade path) ──

async function importFromCwd(specifier) {
  try {
    const require = createRequire(resolve(process.cwd(), "noop.cjs"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch {
    return import(specifier);
  }
}
async function loadTradingDeps() {
  try {
    const [viem, wallets] = await Promise.all([importFromCwd("viem"), importFromCwd("@bnbagent/sdk/wallets")]);
    wallets.setAltanaSdkImporter(() => importFromCwd("@altananetwork/sdk"));
    return { viem, wallets };
  } catch (err) {
    throw new Error(
      "Granting a session needs three packages this skill does not bundle:\n" +
        `  cd ${process.cwd()} && npm i viem @bnbagent/sdk @altananetwork/sdk\n` +
        "Note @altananetwork/sdk is GPL-3.0-or-later and ESM-only.\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const ALTANA_NETWORKS = { 56: "bnb-mainnet", 97: "bnb-testnet" };

/**
 * EIP-7702 upgrade + restricted session grant, driven by the LOCAL derived task
 * key. Node port of packages/frontend/lib/quant/altana.ts:69-132. register:true is
 * mandatory — the relay resolves the session key through the on-chain KeyStore.
 */
async function grantAgenticSession({ taskPrivateKey, chainId, paymentToken, dailyCapU, tradableTokens, venues, ttlSeconds }) {
  const network = ALTANA_NETWORKS[chainId];
  if (!network) throw new Error(`No Altana network for chain ${chainId} (expected 56 or 97).`);
  if (!paymentToken) throw new Error("grantAgenticSession requires paymentToken (the live base token).");
  const { viem, wallets } = await loadTradingDeps();
  const { AltanaWalletProvider, defaultAgentPermissions, serializeSession } = wallets;
  const admin = new AltanaWalletProvider({ privateKey: taskPrivateKey, network });
  const base = defaultAgentPermissions({
    chainId,
    // Override the SDK's hardcoded paymentToken preset (BNB_CHAIN_ADDRESSES[chainId])
    // with the live base token. That preset is the legacy token address; after the
    // base-token migration (U → USDC) a session built without this override caps
    // spend on the OLD token and every trade reverts NoSpendPermissions.
    addresses: { paymentToken },
    tokenSpend: { limit: viem.parseUnits(dailyCapU, 18), period: "day" },
    nativeSpend: { limit: viem.parseUnits("0.05", 18), period: "day" },
    extraCalls: venues.map((to) => ({ to })),
  });
  const permissions = {
    ...base,
    spend: [
      ...(base.spend ?? []),
      ...tradableTokens.map((token) => ({ limit: viem.parseUnits(dailyCapU, 18), period: "day", token: token.address })),
    ],
  };
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const session = await admin.grantSession({ permissions, expiry, register: true });
  return { serialized: serializeSession(session), sessionPublicKey: session.publicKey, expiry: session.expiry };
}

// ── X25519 session seal (client direction; mirrors aacp-quant openEnvelope) ──

const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const pubFromRaw = (raw32) => createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw32]), format: "der", type: "spki" });
const rawOf = (key) => key.export({ type: "spki", format: "der" }).subarray(-32);

function sealSession(recipientRawB64, plaintext) {
  const recipient = pubFromRaw(Buffer.from(recipientRawB64, "base64"));
  const eph = generateKeyPairSync("x25519");
  const ephRaw = rawOf(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, ephRaw, Buffer.from("termix-quant-envelope-v1"), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"),
    ephemeralPublicKey: ephRaw.toString("base64"),
    nonce: nonce.toString("base64"),
    algorithm: "x25519-hkdf-chacha20poly1305",
  };
}

// ── small utils ──────────────────────────────────────────────────────────────

function toUnits(human, decimals) {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a non-negative decimal amount: ${human}`);
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}
function encodeErc20Transfer(to, amountWei) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error(`Bad recipient address: ${to}`);
  const addr = to.slice(2).toLowerCase().padStart(64, "0");
  const amt = BigInt(amountWei).toString(16).padStart(64, "0");
  return `0xa9059cbb${addr}${amt}`;
}
const sigFingerprint = (sig) => createHash("sha256").update(String(sig).replace(/^0x/, "").toLowerCase()).digest("hex");

// ── local state (never the private key) ──────────────────────────────────────

function stateFile() { return resolve(process.cwd(), chainCacheFile(".termix-quant-client", ".json")); }
function loadClientState() { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return {}; } }
function saveClientState(state) { writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }

// Run aacp-tx.mjs for a real-money leg. stderr (preview/risks/progress) streams to
// the user; the final JSON on stdout is captured so we can read the tx hash.
function runTxIntents(intents, { yes }) {
  return new Promise((res, rej) => {
    const argv = [resolve(SCRIPT_DIR, "aacp-tx.mjs"), "--intents", JSON.stringify(intents), ...(yes ? ["--yes"] : [])];
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", rej);
    child.on("exit", (code) => {
      if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { /* preview-only or malformed */ }
      if (code !== 0) return rej(new Error(`aacp-tx.mjs exited ${code}`));
      res(parsed);
    });
  });
}

function isLinked() {
  return activeIdentity() === "linked";
}

// The determinism gate only guards the AGENTIC (MPC) scheme, whose signature
// determinism we verify empirically. LINK signs with a plain web EOA — ECDSA
// RFC-6979 is deterministic by spec — so the gate does not apply.
function assertDeterminismVerified(state) {
  if (isLinked()) return;
  if (state.determinismVerified !== true) {
    throw new Error(
      "Determinism gate not passed. A task wallet you cannot reliably re-derive is unrecoverable.\n" +
        "Run `derive --verify`, then sign the wallet out and reconnect it (`baw auth signout` → `aacp-wallet.mjs connect`), " +
        "then `derive --verify` again until it reports crossSession: PASS.",
    );
  }
}

// LINK mode: get the browser web wallet to personal_sign the derivation message
// via the shared MESSAGE bridge. Returns { domain, signature } — the same web scheme
// the wizard uses, so the terminal derives the SAME task wallets as the website.
function deriveViaLinkBridge(chainId) {
  return signMessageViaBrowser({
    chainId,
    messageKind: "QUANT_TASK_WALLET_DERIVE",
    action: "quantDerive",
    title: "Derive your Termix Quant task wallet",
  });
}

// The task-wallet master seed for the active identity. LINK → browser personal_sign
// (web scheme, same wallets as the site). AGENTIC → Binance EIP-712 (agentic scheme).
async function resolveTaskSeed({ chainId }) {
  if (isLinked()) {
    const { domain, signature } = await deriveViaLinkBridge(chainId);
    return deriveSeedFromWebSig(signature, domain);
  }
  const sig = await signDerivationMessage({ chainId });
  return deriveTaskWalletSeedFromSig(sig);
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdClientStrategy() {
  const strategyId = requireArg("strategy");
  const s = await clientApi("GET", `/api/v1/quant/strategies/${strategyId}`);
  console.log(JSON.stringify({
    id: s.id,
    name: s.name,
    providerAgentId: s.providerAgentId,
    status: s.status,
    mgmtFeeBps: s.mgmtFeeBps,
    minAllocationU: s.minAllocationU,
    capacityU: s.capacityU,
    termDaysOptions: s.termDaysOptions,
    tokenAllowlist: s.tokenAllowlist,
    note: "The provider's encryption key is verified at `create` time (the job returns it).",
  }, null, 2));
}

async function cmdDerive() {
  const index = Number(arg("index") ?? 0);
  const chainId = activeChain().chainId;

  // LINK: the browser web wallet derives (web scheme, same wallets as the site).
  // ECDSA is deterministic by spec, so there is no cross-session gate to run.
  if (isLinked()) {
    const { domain, signature } = await deriveViaLinkBridge(chainId);
    const seed = deriveSeedFromWebSig(signature, domain);
    let address;
    try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }
    console.log(JSON.stringify({ index, address, identity: "linked", domain, note: "Web-scheme address (matches the website). Key never printed or stored." }, null, 2));
    return;
  }

  const sig = await signDerivationMessage({ chainId });
  const seed = deriveTaskWalletSeedFromSig(sig);
  let address;
  try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }

  if (!flag("verify")) {
    console.log(JSON.stringify({ index, address, note: "Address only — the private key is never printed or stored." }, null, 2));
    return;
  }

  const fp = sigFingerprint(sig);
  const state = loadClientState();
  const prior = state.determinism;
  if (prior?.fingerprint) {
    const match = prior.fingerprint === fp;
    state.determinism = { fingerprint: fp, address, at: new Date().toISOString() };
    state.determinismVerified = match;
    saveClientState(state);
    if (!match) {
      console.error(JSON.stringify({
        index, address, crossSession: "FAIL", priorAddress: prior.address,
        error: "The agentic wallet produced a DIFFERENT signature for the same message. Do NOT fund — derived task wallets would be unrecoverable.",
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ index, address, crossSession: "PASS", ok: "Determinism verified — safe to fund." }, null, 2));
    return;
  }
  state.determinism = { fingerprint: fp, address, at: new Date().toISOString() };
  state.determinismVerified = false;
  saveClientState(state);
  console.log(JSON.stringify({
    index, address, recorded: true,
    next: "Now sign the wallet out and reconnect it (`baw auth signout`, then `node scripts/aacp-wallet.mjs connect`), and run `derive --verify` again. An identical address = cross-session determinism confirmed.",
  }, null, 2));
}

async function cmdAllocate() {
  const strategyId = requireArg("strategy");
  const chain = await resolveQuantChainClient();
  const res = await clientApi("POST", "/api/v1/quant/trading-wallets", { chainId: chain.chainId });
  const index = res.derivationIndex ?? res.index;
  if (index == null) throw new Error(`Allocate returned no derivation index: ${JSON.stringify(res)}`);
  const state = loadClientState();
  state.pending = { strategyId, index, chainId: chain.chainId };
  saveClientState(state);
  console.log(JSON.stringify({ index, strategyId, next: `register --index ${index}` }, null, 2));
}

async function cmdRegister() {
  const index = Number(arg("index") ?? loadClientState().pending?.index);
  if (!Number.isInteger(index)) throw new Error("--index is required (or run `allocate` first)");
  const chain = await resolveQuantChainClient();
  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let address;
  try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }
  await clientApi("PATCH", `/api/v1/quant/trading-wallets/${index}`, { chainId: chain.chainId, address });
  const state = loadClientState();
  state.pending = { ...(state.pending || {}), index, address, chainId: chain.chainId };
  saveClientState(state);
  console.log(JSON.stringify({ index, address, registered: true, next: `fund --index ${index} --allocationU <U>` }, null, 2));
}

async function cmdFund() {
  const state = loadClientState();
  assertDeterminismVerified(state);
  const index = Number(arg("index") ?? state.pending?.index);
  const address = arg("address") ?? state.pending?.address;
  if (!address) throw new Error("No task wallet address. Run `register --index N` first.");
  const allocationU = requireArg("allocationU");
  const gasBnb = String(arg("gas-bnb") ?? "0.02");
  const chain = await resolveQuantChainClient();
  const intents = [
    { to: chain.uToken, data: encodeErc20Transfer(address, toUnits(allocationU, chain.uDecimals)), action: "quant-fund-principal" },
    { to: address, value: toUnits(gasBnb, 18), action: "quant-fund-gas" },
  ];
  const yes = flag("yes");
  process.stderr.write(
    `[quant] funding task wallet ${address}: ${allocationU} U (principal) + ${gasBnb} BNB (gas).\n` +
      (yes ? "" : "[quant] preview only — re-run with --yes to broadcast.\n"),
  );
  await runTxIntents(intents, { yes });
  if (yes) console.log(JSON.stringify({ funded: address, allocationU, gasBnb, next: "create …" }, null, 2));
}

async function cmdCreate() {
  const strategyId = requireArg("strategy");
  const state = loadClientState();
  const index = Number(arg("index") ?? state.pending?.index);
  const address = arg("address") ?? state.pending?.address;
  if (!address) throw new Error("No task wallet address. Run `register` first.");
  const allocationU = requireArg("allocationU");
  const dailyCapU = requireArg("dailyCapU");
  const termDays = Number(requireArg("termDays"));
  const job = await clientApi("POST", "/api/v1/quant/jobs", {
    strategyId, tradingWalletAddress: address, allocationU, dailyCapU, termDays,
  });
  const encKey = job.agentEncryptionPublicKey;
  if (!encKey) {
    throw new Error(
      `Job ${job.id} was created (DRAFT) but its provider agent has published no encryption key, so it cannot receive a session. ` +
        "Ask the provider to run `aacp-quant.mjs register-key`. Nothing was funded by this step.",
    );
  }
  state.jobs = state.jobs || {};
  state.jobs[job.id] = {
    jobId: job.id, strategyId, index, address, allocationU, dailyCapU, termDays,
    recipientAgentId: job.recipientAgentId, agentEncryptionPublicKey: encKey,
  };
  saveClientState(state);
  console.log(JSON.stringify({ jobId: job.id, status: job.status, next: `deliver --index ${index} --job ${job.id}` }, null, 2));
}

async function cmdDeliver() {
  const state = loadClientState();
  assertDeterminismVerified(state);
  const jobId = requireArg("job");
  const job = state.jobs?.[jobId];
  if (!job) throw new Error(`No local record for job ${jobId}. Run \`create\` first.`);
  const index = Number(arg("index") ?? job.index);
  const chain = await resolveQuantChainClient();
  const strategy = await clientApi("GET", `/api/v1/quant/strategies/${job.strategyId}`);
  const { venues, tradableTokens } = buildSessionAllowlist(chain, strategy);

  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let granted;
  try {
    const wallet = await deriveTaskWallet(seed, index);
    try {
      if (wallet.address.toLowerCase() !== String(job.address).toLowerCase()) {
        throw new Error(
          `Re-derived address ${wallet.address} does not match the registered task wallet ${job.address}. ` +
            "Refusing to grant. Your funds are at the REGISTERED address; do not open a new job with this account until this is resolved.",
        );
      }
      granted = await grantAgenticSession({
        taskPrivateKey: wallet.privateKey,
        chainId: chain.chainId,
        // Live base token — overrides the SDK's stale hardcoded paymentToken preset
        // so the session can spend the current settlement token (USDC post-migration).
        paymentToken: chain.uToken,
        dailyCapU: job.dailyCapU,
        tradableTokens,
        venues,
        ttlSeconds: job.termDays * 86_400,
      });
    } finally {
      wallet.privateKey = `0x${"0".repeat(64)}`; // best-effort scrub (JS strings are immutable)
    }
  } finally {
    wipeBytes(seed);
  }

  const envelope = sealSession(job.agentEncryptionPublicKey, granted.serialized);
  const sessionExpiresAt = new Date(granted.expiry * 1000).toISOString();
  await clientApi("POST", `/api/v1/quant/jobs/${jobId}/session`, {
    recipientAgentId: job.recipientAgentId,
    ciphertext: envelope.ciphertext,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    nonce: envelope.nonce,
    algorithm: envelope.algorithm,
    sessionPublicKey: granted.sessionPublicKey,
    sessionExpiresAt,
  });
  console.log(JSON.stringify({ jobId, sessionPublicKey: granted.sessionPublicKey, sessionExpiresAt, status: "session delivered", next: `checkout --job ${jobId}` }, null, 2));
}

async function cmdCheckout() {
  const jobId = requireArg("job");
  const state = loadClientState();
  let clientAgentId = arg("client-agent");
  if (!clientAgentId) {
    const agents = await clientApi("GET", "/api/v1/agents");
    const list = Array.isArray(agents) ? agents : agents?.items ?? [];
    clientAgentId = list[0]?.id;
  }
  if (!clientAgentId) {
    throw new Error("Checkout needs one of your own agents (clientAgentId); this account owns none. Mint an agent first, or pass --client-agent <id>.");
  }
  const res = await clientApi("POST", `/api/v1/quant/jobs/${jobId}/checkout`, { clientAgentId, idempotencyKey: `quant-${jobId}` });
  const checkoutSessionId = res.checkoutSessionId ?? res.checkoutId ?? res.id;
  if (state.jobs?.[jobId]) { state.jobs[jobId].checkoutSessionId = checkoutSessionId; saveClientState(state); }
  console.log(JSON.stringify({ jobId, checkoutSessionId, feeU: res.feeU, next: `escrow-fee --checkout ${checkoutSessionId}` }, null, 2));
}

async function cmdEscrowFee() {
  const checkoutId = requireArg("checkout");
  const yes = flag("yes");

  const approve = await clientApi("POST", `/api/v1/checkout/${checkoutId}/tx-intent`, { action: "approveEscrow" });
  const r1 = await runTxIntents([approve], { yes });
  if (!yes) {
    console.log(JSON.stringify({ stage: "preview", note: "Previewed approveEscrow. Re-run with --yes to broadcast approve + createOrder + confirm." }, null, 2));
    return;
  }

  let createOrder;
  try {
    createOrder = await clientApi("POST", `/api/v1/checkout/${checkoutId}/tx-intent`, { action: "createOrder" });
  } catch (err) {
    if (/already|funded|recover/i.test(String(err.message))) {
      await clientApi("POST", `/api/v1/checkout/${checkoutId}/recover`, {});
      console.log(JSON.stringify({ checkoutId, recovered: true, note: "Order was already funded; ran /recover instead." }, null, 2));
      return;
    }
    throw err;
  }
  const r2 = await runTxIntents([createOrder], { yes });
  const txHash = r2?.results?.find((x) => x.txHash)?.txHash;
  if (!txHash) {
    throw new Error("createOrder produced no tx hash (App confirmation pending?). Find it with `baw wallet tx-history --json`, then POST /checkout/" + checkoutId + "/confirm { txHash } via aacp-api.");
  }
  await clientApi("POST", `/api/v1/checkout/${checkoutId}/confirm`, { txHash });
  console.log(JSON.stringify({ checkoutId, approveTx: r1?.results?.[0]?.txHash ?? null, createOrderTx: txHash, confirmed: true, status: "management fee escrowed — job is live" }, null, 2));
}

const balanceOfCall = (token, owner) =>
  rpc("eth_call", [{ to: token, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]);

// Recover a task wallet at term end: send its ERC-20 balances (U + any tradable
// tokens it holds) back to the login wallet, THEN the remaining native BNB. Token
// legs FIRST, native LAST — each token transfer costs native, so draining native
// first would strand the tokens (load-bearing order, mirrors frontend sweep.ts).
// Signed LOCALLY by the re-derived task key; broadcast via raw RPC.
async function cmdSweep() {
  const state = loadClientState();
  const jobs = Object.values(state.jobs || {});
  const index = Number(arg("index") ?? state.pending?.index ?? jobs[0]?.index);
  if (!Number.isInteger(index)) throw new Error("--index is required (or run the flow first so it is in state).");
  const registered = arg("address") ?? state.pending?.address ?? jobs.find((j) => j.index === index)?.address;
  const chain = await resolveQuantChainClient();
  const dest = String(arg("to") ?? (await agenticAddress()));
  if (!/^0x[a-fA-F0-9]{40}$/.test(dest)) throw new Error(`--to is not a valid address: ${dest}`);
  const yes = flag("yes");

  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let wallet;
  try {
    wallet = await deriveTaskWallet(seed, index);
  } finally {
    wipeBytes(seed);
  }
  try {
    if (registered && wallet.address.toLowerCase() !== String(registered).toLowerCase()) {
      throw new Error(`Re-derived address ${wallet.address} != registered ${registered}. Refusing to sweep — funds are at the registered address.`);
    }
    const from = wallet.address;
    const pk = wallet.privateKey;
    const chainId = await getChainId();

    // Dedupe U + tradable tokens by address.
    const seen = new Set();
    const tokens = [{ address: chain.uToken, symbol: "U", decimals: chain.uDecimals }, ...chain.tokens].filter((t) => {
      const k = t.address.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const balances = [];
    for (const t of tokens) {
      const bal = BigInt((await balanceOfCall(t.address, from)) || "0x0");
      if (bal > 0n) balances.push({ ...t, bal });
    }
    const nativeBal = BigInt((await rpc("eth_getBalance", [from, "pending"])) || "0x0");

    if (balances.length && nativeBal === 0n) {
      throw new Error(`Task wallet ${from} holds tokens but has 0 BNB for gas. Send a little BNB to it first (e.g. \`aacp-tx.mjs --intent '{"to":"${from}","value":"2000000000000000"}' --yes\`), then sweep.`);
    }

    const plan = [
      ...balances.map((b) => ({ kind: "token", ...b, human: Number(b.bal) / 10 ** b.decimals })),
      ...(nativeBal > 0n ? [{ kind: "native", bal: nativeBal, human: Number(nativeBal) / 1e18 }] : []),
    ];
    if (plan.length === 0) {
      console.log(JSON.stringify({ from, dest, note: "Task wallet already empty — nothing to sweep." }, null, 2));
      return;
    }
    if (!yes) {
      console.log(JSON.stringify({
        stage: "preview", from, dest,
        willSweep: plan.map((p) => ({ token: p.kind === "native" ? "BNB" : p.symbol, amount: p.human })),
        note: "Re-run with --yes to broadcast (token legs first, native last).",
      }, null, 2));
      return;
    }

    const results = [];
    let nonce = await getNonce(from);
    // Token legs first.
    for (const b of balances) {
      const data = encodeErc20Transfer(dest, b.bal.toString());
      const fees = await getFees();
      const gas = await estimateGas({ from, to: b.address, value: "0", data });
      const signed = signTransaction(pk, { chainId, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: b.address, value: "0", data });
      const txHash = await sendRawTransaction(signed.raw, signed.hash);
      process.stderr.write(`[quant] sweep ${b.symbol} nonce=${nonce} tx=${txHash}\n`);
      const rc = await waitReceipt(txHash);
      results.push({ token: b.symbol, amount: Number(b.bal) / 10 ** b.decimals, txHash, status: rc.status === "0x1" ? "success" : "reverted" });
      nonce += 1n;
    }
    // Native last: send balance minus this tx's gas cost.
    const freshNative = BigInt((await rpc("eth_getBalance", [from, "pending"])) || "0x0");
    if (freshNative > 0n) {
      const fees = await getFees();
      const gas = await estimateGas({ from, to: dest, value: "0", data: "0x" });
      const cost = gas * fees.maxFeePerGas;
      const value = freshNative - cost;
      if (value > 0n) {
        const signed = signTransaction(pk, { chainId, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: dest, value: value.toString(), data: "0x" });
        const txHash = await sendRawTransaction(signed.raw, signed.hash);
        process.stderr.write(`[quant] sweep BNB nonce=${nonce} tx=${txHash}\n`);
        const rc = await waitReceipt(txHash);
        results.push({ token: "BNB", amount: Number(value) / 1e18, txHash, status: rc.status === "0x1" ? "success" : "reverted" });
      } else {
        results.push({ token: "BNB", skipped: "remaining balance below gas cost" });
      }
    }
    console.log(JSON.stringify({ sweptTo: dest, from, results }, null, 2));
  } finally {
    wallet.privateKey = `0x${"0".repeat(64)}`;
  }
}

const COMMANDS = {
  "client-strategy": cmdClientStrategy,
  derive: cmdDerive,
  allocate: cmdAllocate,
  register: cmdRegister,
  fund: cmdFund,
  create: cmdCreate,
  deliver: cmdDeliver,
  checkout: cmdCheckout,
  "escrow-fee": cmdEscrowFee,
  sweep: cmdSweep,
};

// Exported pure helpers so the self-test can drive them without a live wallet.
export { buildSessionAllowlist, encodeErc20Transfer, sealSession, toUnits };

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const run = COMMANDS[cmd];
  if (!run) {
    console.error(`Usage: node quant-client.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`);
    process.exit(1);
  }
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
