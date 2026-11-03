#!/usr/bin/env node
//
// Termix Platform — Binance Agentic Wallet adapter.
//
// This is the DEFAULT way the skill holds a wallet: the key stays inside the
// Binance Agentic Wallet, and this script only asks the `baw` CLI to sign. No
// private key ever reaches the shell, the environment, or the transcript.
//
// It covers all three places the skill needs a wallet:
//   • login              → EIP-712 typed data (`/auth/wallet` signatureType=eip712)
//   • A2A runtime token  → EIP-712 typed data (`x-wallet-signature-type: eip712`)
//   • on-chain tx        → `contract-call preview` + `execute` (Developer Mode)
//
// Subcommands:
//   status                      Is `baw` installed / connected / Developer Mode on,
//                               and which address does it hold on the selected chain.
//   connect                     Full sign-in: pairing code → open the browser →
//                               block until the user confirms in the Binance App.
//   address                     Print the wallet address on the selected chain.
//   sign-typed --data '<json>'  Sign EIP-712 typed data, print the 0x signature.
//   send-tx --to .. [--data ..] [--value <wei>] [--yes] [--request-id <id>]
//                               Preview a transaction (default) or, with --yes,
//                               preview + execute it.
//
// Env:
//   TERMIX_WALLET_MODE   agentic (default) | key. `key` is the legacy private-key
//                        path in a2a-runtime.mjs / aacp-tx.mjs; nothing here runs.
//   AACP_CHAIN           bsc (default) | base | rh — also decides which
//                        binanceChainId the Binance wallet is asked to sign on.
//                        Whether the wallet has that chain is checked live via
//                        `baw wallet chains` (assertChainSupported).
//   BAW_BIN              Override the `baw` executable name/path.
//
// Requires the Binance Agentic Wallet CLI:  npm install -g @binance/agentic-wallet
//
import { spawn } from "node:child_process";
import { activeChain, activeChainSlug } from "./aacp-chain.mjs";
import { activeIdentity } from "./aacp-credentials.mjs";

const REQUIRED_CLI_VERSION = "1.9.0";
const BAW = process.env.BAW_BIN?.trim() || "baw";
const INSTALL_HINT = `npm install -g @binance/agentic-wallet@${REQUIRED_CLI_VERSION}`;

// ── mode ────────────────────────────────────────────────────────────────────

/**
 * Which wallet the skill signs with. Agentic wallet is the default on purpose:
 * a private key pasted into a shell command is a leak waiting to happen, and it
 * ends up in shell history, process listings and (worst) the chat transcript.
 * `TERMIX_WALLET_MODE=key` is the explicit opt-out for people who do not want
 * to use a Binance wallet.
 */
export function walletMode() {
  const raw = (process.env.TERMIX_WALLET_MODE || "").trim().toLowerCase();
  if (!raw) return "agentic";
  if (raw !== "agentic" && raw !== "key") {
    throw new Error(`Unknown TERMIX_WALLET_MODE "${process.env.TERMIX_WALLET_MODE}" — expected "agentic" or "key".`);
  }
  return raw;
}

// ── baw plumbing ────────────────────────────────────────────────────────────

export class BawError extends Error {
  constructor(message, { code, name, data } = {}) {
    super(message);
    this.bawCode = code;
    this.bawName = name;
    this.bawData = data;
  }
}

function runBaw(argv, { timeoutMs = 120_000, onTick } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(BAW, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const started = Date.now();
    const ticker = onTick ? setInterval(() => onTick(Math.round((Date.now() - started) / 1000)), 10_000) : null;
    ticker?.unref?.();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      child.kill("SIGTERM");
      reject(new Error(`\`${BAW} ${argv.join(" ")}\` timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      if (err.code === "ENOENT") {
        reject(new Error(
          `The Binance Agentic Wallet CLI (\`${BAW}\`) is not installed.\n` +
          `Install it with:  ${INSTALL_HINT}\n` +
          `Or switch to the private-key mode with TERMIX_WALLET_MODE=key (see docs/wallet-login.md).`,
        ));
      } else reject(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run a `baw` subcommand with --json and return `data`.
 *
 * The CLI reports business failures in the JSON body (`success:false`) rather
 * than the exit code, so both are folded into one BawError carrying the CLI's
 * own message — the skill relays those verbatim instead of guessing at causes.
 */
export async function bawJson(argv, opts = {}) {
  const { stdout, stderr } = await runBaw([...argv, "--json"], opts);
  const text = stdout.trim();
  if (!text) {
    throw new Error(`\`${BAW} ${argv.join(" ")}\` produced no output.${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  }
  // The CLI occasionally prefixes banners/spinner lines; take the last JSON object.
  const start = text.indexOf("{");
  let parsed;
  try {
    parsed = JSON.parse(start >= 0 ? text.slice(start) : text);
  } catch {
    throw new Error(`Could not parse \`${BAW} ${argv.join(" ")}\` output as JSON:\n${text.slice(0, 400)}`);
  }
  if (parsed?.success === false) {
    const err = parsed.error ?? {};
    throw new BawError(err.message || `\`${BAW} ${argv.join(" ")}\` failed`, { code: err.code, name: err.name, data: err.data });
  }
  return parsed?.data ?? parsed;
}

// Binance's risk service answers with this code when it refuses to sign AT ALL.
// Observed on Robinhood (4663) for every external-signing request — EIP-712
// login, contract-call preview, even a read-only balanceOf — while the identical
// request on BSC / Base passes, with the same wallet and an equally empty
// balance. The chain IS on `wallet chains`, so assertChainSupported cannot
// catch it, and the raw message ("risk is too high") reads like a problem with
// the transaction, which it is not. Name the real situation and the ways out.
const RISK_BLOCKED_CODE = 351803;
function explainRiskBlock(err) {
  if (!(err instanceof BawError) || Number(err.bawCode) !== RISK_BLOCKED_CODE) return err;
  const chain = activeChain();
  return new Error(
    `${err.message}\n` +
    `The Binance wallet's risk service refused to sign on ${chain.label} (AACP_CHAIN=${chain.slug}, chain ${chain.chainId}). ` +
    `On some chains it lists (Robinhood) it does this for EVERY external-signing request; on BSC it refuses ERC-20 ` +
    `approvals to some Termix contracts (TermixEscrow, USDT TermixStaking), so this wallet cannot fund an order or ` +
    `stake USDT there — stake in USDC instead. Nothing in this skill changes that. Either link this terminal to the web account ` +
    `(\`node scripts/aacp-link.mjs start\`, the user's browser wallet signs) or use TERMIX_WALLET_MODE=key with WALLET_KEY on this chain.`,
  );
}

// ── chain / address ─────────────────────────────────────────────────────────

/** The `binanceChainId` for the chain AACP_CHAIN selected (a decimal string). */
export function binanceChainId() {
  return String(activeChain().chainId);
}

/**
 * The Binance wallet only exists on mainnets, and only on the ones Binance has
 * enabled — `baw wallet chains` is the source of truth, asked live here. Dev
 * builds of this skill rewrite the registry to testnets (BSC 56→97, Base
 * 8453→84532, Robinhood 4663→46630), where agentic mode cannot work at all —
 * fail loudly rather than let the operator discover it via an opaque CLI error
 * three commands later.
 */
export async function assertChainSupported() {
  const want = binanceChainId();
  const chains = await bawJson(["wallet", "chains"]);
  const list = Array.isArray(chains) ? chains : chains?.items ?? [];
  const hit = list.find((c) => String(c.binanceChainId) === want);
  if (!hit) {
    throw new Error(
      `The Binance Agentic Wallet does not support chain id ${want} (AACP_CHAIN=${activeChainSlug()}, ${activeChain().network}).\n` +
      `Supported: ${list.map((c) => `${c.simpleName ?? c.name} (${c.binanceChainId})`).join(", ")}.\n` +
      `Testnets are never supported. Either link this terminal to the web account (\`node scripts/aacp-link.mjs start\`, ` +
      `the user's browser wallet signs) or use TERMIX_WALLET_MODE=key with WALLET_KEY on this chain.`,
    );
  }
  return hit;
}

/** Wallet address on the selected chain, or null when not connected. */
export async function agenticAddress() {
  const want = binanceChainId();
  const data = await bawJson(["wallet", "address"]);
  const entry = (data?.addresses ?? []).find((a) => String(a.binanceChainId) === want);
  if (!entry?.address) {
    throw new Error(`The connected Binance wallet has no address on chain ${want} (AACP_CHAIN=${activeChainSlug()}).`);
  }
  return entry.address;
}

export async function walletStatus() {
  const data = await bawJson(["wallet", "status"]);
  return data?.status ?? "UNKNOWN";
}

async function walletSettings() {
  return bawJson(["wallet", "settings"]).catch(() => null);
}

/** Throw with an actionable message unless the wallet is signed in and ready. */
export async function ensureConnected() {
  const status = await walletStatus();
  if (status === "CONNECTED") return status;
  if (status === "CREATING") {
    throw new Error("The Binance wallet is still being set up (status CREATING). Wait a few seconds and try again.");
  }
  throw new Error(
    "The Binance Agentic Wallet is not signed in.\n" +
    "Run:  node scripts/aacp-wallet.mjs connect\n" +
    "It shows a pairing code, opens the browser for you, and waits while you confirm in the Binance App.",
  );
}

// ── connect (sign-in) ───────────────────────────────────────────────────────

// Exported: aacp-link.mjs and aacp-tx.mjs open Termix web pages the same way.
export function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, argv, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole sign-in, driven end to end so the user is never left guessing.
 *
 * `auth verify` is a FOREGROUND blocking call and must stay alive until the user
 * confirms in the App — killing or backgrounding it can leave the CLI
 * unauthenticated even though the App says it worked. Hence the heartbeat on
 * stderr instead of a detached process: silence for five minutes is
 * indistinguishable from a hang.
 */
export async function connect() {
  const cli = await bawJson(["cli-check", "--required-version", REQUIRED_CLI_VERSION]).catch((err) => {
    if (err instanceof BawError) return null;
    throw err;
  });
  if (cli?.needUpdateCli) {
    process.stderr.write(`[wallet] baw ${cli.currentCliVersion} is older than ${REQUIRED_CLI_VERSION}. Upgrade with: ${INSTALL_HINT}\n`);
  }

  const signin = await bawJson(["auth", "signin"]);
  if (signin?.status === "ALREADY_CONNECTED") {
    const address = await agenticAddress();
    return { status: "ALREADY_CONNECTED", address, chain: activeChainSlug(), ...CONNECTED_NEXT_STEP };
  }

  const { pairingCode, urlForWeb, qrCodeId } = signin;
  // The pairing code must be shown verbatim — it is what the user matches
  // against the screen in the Binance App.
  process.stderr.write(
    `\n[wallet] Sign in to the Binance Agentic Wallet\n` +
    `[wallet]   Pairing code: ${pairingCode}\n` +
    `[wallet]   Link: ${urlForWeb}\n`,
  );
  const opened = openInBrowser(urlForWeb);
  process.stderr.write(
    opened
      ? `[wallet]   Opening that link in your browser…\n`
      : `[wallet]   Could not open a browser automatically — open the link above yourself.\n`,
  );
  process.stderr.write(
    `[wallet]   Scan the QR with the Binance App, check the pairing code matches, and confirm.\n` +
    `[wallet]   Waiting… (the code expires in about 5 minutes)\n`,
  );

  try {
    await bawJson(["auth", "verify", "--qrCodeId", qrCodeId], {
      timeoutMs: 330_000,
      onTick: (secs) => process.stderr.write(`[wallet]   still waiting for your confirmation in the Binance App… ${secs}s (code ${pairingCode})\n`),
    });
  } catch (err) {
    if (err instanceof BawError && err.bawName === "AUTH_REJECTED") {
      // Re-verifying a dead qrCodeId can never succeed; the only cure is a new code.
      throw new Error(`The pairing code expired or was rejected: ${err.message}\nRun \`connect\` again to get a fresh code.`);
    }
    throw err;
  }

  // The App showing "signed in" is not proof the CLI holds a session — the CLI
  // is the source of truth, so re-check rather than trust the happy path.
  const status = await walletStatus();
  if (status !== "CONNECTED") {
    throw new Error(`The Binance App confirmed, but the CLI still reports ${status}. Run \`connect\` again to restart the sign-in.`);
  }
  const address = await agenticAddress();
  process.stderr.write(`[wallet] Connected as ${address} on ${activeChain().network}.\n`);
  return { status: "CONNECTED", address, chain: activeChainSlug(), ...CONNECTED_NEXT_STEP };
}

// A connected wallet is not an account yet. Saying so here is what stops the
// operator being told "done" and left with nothing to do (docs/onboarding.md).
const CONNECTED_NEXT_STEP = {
  next: "Log in to Termix with this wallet: `node scripts/a2a-runtime.mjs login`",
  tellUser: "The wallet is connected; the next step is signing in to Termix. Offer it, then `node scripts/aacp-next.mjs` shows what opens up after that.",
};

// ── Developer Mode (external signing) ───────────────────────────────────────

/**
 * `sign-message` and `contract-call` are Developer-Mode features. It can ONLY be
 * turned on inside the Binance App, so the useful thing to do here is say that
 * plainly with the quota numbers, not attempt the call and relay a raw code.
 */
async function requireDevMode() {
  const settings = await walletSettings();
  const dev = settings?.devMode;
  if (dev?.enabled) return settings;
  throw new Error(
    "Developer Mode is off in the Binance Agentic Wallet, and external signing (login signature, runtime token, on-chain transactions) needs it.\n" +
    "Open the Binance App → Agentic Wallet settings → enable Developer Mode (it can only be enabled there, and it expires after a while), then run this command again.\n" +
    "Check it any time with:  baw wallet settings --json",
  );
}

// ── EIP-712 signing ─────────────────────────────────────────────────────────

/**
 * `eth_signTypedData_v4` clients expect the EIP712Domain member list to be part
 * of `types`. The backend deliberately omits it (viem derives it server-side),
 * so add it here, derived from whichever domain fields are actually present.
 */
function withDomainType(typedData) {
  if (typedData?.types?.EIP712Domain) return typedData;
  const fields = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ];
  const EIP712Domain = fields
    .filter(([key]) => typedData?.domain?.[key] !== undefined && typedData.domain[key] !== null)
    .map(([name, type]) => ({ name, type }));
  return { ...typedData, types: { EIP712Domain, ...typedData.types } };
}

/**
 * The CLI returns the signature split: `signature` is r‖s (64 bytes, unprefixed)
 * and `signatureRecovery` is the recovery byte on its own (e.g. "01"). Everything
 * downstream — viem's verifyTypedData, ERC-1271 verifiers — wants the 65-byte
 * r‖s‖v form.
 *
 * The recovery id is normalized to 27/28: viem recovers from 0/1 too, but plenty
 * of on-chain verifiers call ecrecover directly and reject a raw 0/1 v.
 */
function joinSignature(data) {
  const raw = String(data?.signature ?? "").replace(/^0x/, "");
  if (!raw) throw new Error("The Binance wallet returned no signature.");
  if (raw.length === 130) return `0x${raw}`; // already r‖s‖v
  if (raw.length !== 128) {
    throw new Error(`Unexpected signature length from the Binance wallet (${raw.length} hex chars).`);
  }
  const recoveryRaw = String(data?.signatureRecovery ?? "").replace(/^0x/, "");
  const recovery = Number.parseInt(recoveryRaw, 16);
  if (!Number.isFinite(recovery)) {
    throw new Error(`The Binance wallet returned no usable signatureRecovery ("${recoveryRaw}").`);
  }
  const v = recovery < 27 ? recovery + 27 : recovery;
  return `0x${raw}${v.toString(16).padStart(2, "0")}`;
}

/**
 * Sign EIP-712 typed data with the agentic wallet and return a 65-byte 0x
 * signature. `label` is only used in the progress lines.
 *
 * The wallet may route the request to the Binance App for confirmation
 * (`PENDING_CONFIRMATION`), in which case this polls `sign-message result` and
 * keeps telling the user what it is waiting for.
 */
export async function signTypedData(typedData, { label = "signature", timeoutMs = 300_000 } = {}) {
  await ensureConnected();
  await requireDevMode();
  const address = await agenticAddress();
  const payload = JSON.stringify({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(withDomainType(typedData))],
  });

  const preview = await bawJson([
    "sign-message", "preview",
    "--binanceChainId", binanceChainId(),
    "--signType", "EIP712",
    "--message", payload,
  ]).catch((err) => { throw explainRiskBlock(err); });
  const risks = preview?.risks?.riskDetails ?? [];
  for (const risk of risks) {
    process.stderr.write(`[wallet] risk (${risk.riskType}): ${risk.title} — ${risk.description}\n`);
  }
  if (!preview?.requestId) throw new Error("The signature preview returned no requestId; not attempting to sign.");

  const executed = await bawJson(["sign-message", "execute", "--requestId", preview.requestId]);
  if (executed?.status === "COMPLETED") return { signature: joinSignature(executed), address, risks };

  if (executed?.status === "PENDING_CONFIRMATION") {
    process.stderr.write(`[wallet] The Binance App needs to approve this ${label}. Open the app and confirm — waiting…\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const result = await bawJson(["sign-message", "result", "--order-id", executed.orderId]);
      if (result?.status === "COMPLETED") return { signature: joinSignature(result), address, risks };
      if (result?.status === "REJECTED" || result?.status === "EXPIRED") {
        throw new Error(`The ${label} was ${String(result.status).toLowerCase()} in the Binance App.`);
      }
      process.stderr.write(`[wallet]   still waiting for approval in the Binance App… (order ${executed.orderId})\n`);
    }
    throw new Error(`Timed out waiting for the Binance App to approve this ${label} (order ${executed.orderId}).`);
  }

  throw new Error(`Unexpected sign-message status from the Binance wallet: ${executed?.status ?? "(none)"}`);
}

// ── on-chain transactions ───────────────────────────────────────────────────

function summarizePreview(preview) {
  const risks = preview?.risks?.riskDetails ?? [];
  const addresses = Object.entries(preview?.risks?.addresses ?? {}).map(([address, info]) => ({
    address,
    riskLevel: info?.riskLevel,
    details: (info?.riskDetails ?? []).map((d) => `${d.title} — ${d.description}`),
  }));
  return {
    requestId: preview?.requestId,
    parsedTx: preview?.parsedTx ?? null,
    balanceChanges: preview?.simulationResult?.balanceChanges ?? [],
    allowanceChanges: preview?.simulationResult?.allowanceChanges ?? [],
    authorityChanges: preview?.simulationResult?.authorityChanges ?? [],
    risks: risks.map((r) => ({ type: r.riskType, title: r.title, description: r.description })),
    riskAddresses: addresses,
    requireConfirmation: Boolean(preview?.requireConfirmation),
    expiresAt: preview?.expiresAt ?? null,
  };
}

/** Simulate a transaction and return everything the user needs to decide. */
export async function previewTx({ to, data = "0x", value = "0" }) {
  await ensureConnected();
  await requireDevMode();
  await assertChainSupported();
  const from = await agenticAddress();
  const argv = [
    "contract-call", "preview",
    "--binanceChainId", binanceChainId(),
    "--from", from,
    "--to", to,
    // `--value` is raw wei here, unlike the human-readable `--amount` elsewhere
    // in the CLI. Intents already carry wei, so pass them straight through.
    "--value", String(value ?? "0"),
  ];
  if (data && data !== "0x") argv.push("--inputData", data);
  const preview = await bawJson(argv).catch((err) => { throw explainRiskBlock(err); });
  return { from, ...summarizePreview(preview) };
}

/**
 * Execute a previously previewed transaction. `BROADCASTED` returns a txHash;
 * `PENDING_CONFIRMATION` means the Binance App must approve it first — that is
 * reported back rather than silently polled, because the caller (aacp-tx.mjs)
 * decides whether to wait for the receipt on its own RPC.
 */
export async function executeTx(requestId) {
  const result = await bawJson(["contract-call", "execute", "--requestId", requestId]);
  return {
    status: result?.status ?? "UNKNOWN",
    txHash: result?.txHash ?? null,
    orderId: result?.orderId ?? null,
    message: result?.message ?? null,
  };
}

/** preview → (optionally) execute, in one call. */
export async function sendTx({ to, data = "0x", value = "0", yes = false, requestId }) {
  const preview = requestId ? { requestId, from: await agenticAddress() } : await previewTx({ to, data, value });
  if (!yes) {
    return {
      stage: "preview",
      ...preview,
      hint: `Confirm with the user, then re-run the same command with --yes (preview is cached briefly; a stale one just needs another preview).`,
    };
  }
  const executed = await executeTx(preview.requestId);
  if (executed.status === "PENDING_CONFIRMATION") {
    process.stderr.write(`[wallet] The Binance App must approve this transaction (order ${executed.orderId}). Open the app and confirm.\n`);
  }
  return { stage: "executed", ...preview, ...executed };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function cmdStatus() {
  const chain = { chain: activeChainSlug(), network: activeChain().network, chainId: activeChain().chainId };
  // A linked terminal acts as the web account and signs in the browser, so the
  // Binance wallet is optional there — say so before reporting it missing.
  const identity = activeIdentity();
  const out = { mode: walletMode(), identity, ...chain, cli: null, wallet: "UNKNOWN", address: null, devMode: null, hint: null };
  const cli = await bawJson(["cli-check", "--required-version", REQUIRED_CLI_VERSION]).catch((err) => ({ error: err.message }));
  if (cli?.error) {
    out.cli = cli.error;
    out.hint = identity === "linked"
      ? "Not needed while linked to the web account (docs/link.md) — the user signs in the browser. Install it only to use the skill's own wallet."
      : `Install the Binance Agentic Wallet CLI:  ${INSTALL_HINT}  (or link the web account with \`node scripts/aacp-link.mjs start\`, which needs no wallet here; or TERMIX_WALLET_MODE=key for a private key)`;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  out.cli = { version: cli.currentCliVersion, needUpdate: Boolean(cli.needUpdateCli), required: REQUIRED_CLI_VERSION };
  out.wallet = await walletStatus();
  if (out.wallet !== "CONNECTED") {
    out.hint = "Not signed in — run `node scripts/aacp-wallet.mjs connect`.";
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  out.address = await agenticAddress().catch((err) => err.message);
  const settings = await walletSettings();
  out.devMode = settings?.devMode
    ? { enabled: Boolean(settings.devMode.enabled), expiresAt: settings.devMode.expiresAt ?? null, dailyLimit: settings.devMode.dailyLimit ?? null, quotaUsed: settings.developerModeQuotaUsed ?? null }
    : null;
  const supported = await assertChainSupported().then(() => true).catch((err) => err.message);
  if (supported !== true) out.hint = supported;
  else if (!out.devMode?.enabled) out.hint = "Developer Mode is off — enable it in the Binance App before signing anything (login, runtime token, transactions).";
  else out.hint = "Ready. `node scripts/a2a-runtime.mjs login` signs in to Termix with this wallet; `node scripts/aacp-next.mjs` then lists what the user can do.";
  console.log(JSON.stringify(out, null, 2));
}

async function cmdSignTyped() {
  const raw = arg("data");
  if (typeof raw !== "string") throw new Error("Provide --data '<eip-712-typed-data-json>'");
  const { signature, address } = await signTypedData(JSON.parse(raw), { label: arg("label", "signature") });
  console.log(JSON.stringify({ address, signature }, null, 2));
}

async function cmdSendTx() {
  const to = arg("to");
  if (typeof to !== "string") throw new Error("Provide --to <0xaddress>");
  const result = await sendTx({
    to,
    data: typeof arg("data") === "string" ? arg("data") : "0x",
    value: typeof arg("value") === "string" ? arg("value") : "0",
    yes: args.includes("--yes"),
    requestId: typeof arg("request-id") === "string" ? arg("request-id") : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

function help() {
  console.log(`Termix — Binance Agentic Wallet adapter (keyless signing)

  node scripts/aacp-wallet.mjs status
  node scripts/aacp-wallet.mjs connect
  node scripts/aacp-wallet.mjs address
  node scripts/aacp-wallet.mjs sign-typed --data '<typed-data-json>'
  node scripts/aacp-wallet.mjs send-tx --to 0x.. [--data 0x..] [--value <wei>] [--yes]

Env: TERMIX_WALLET_MODE=agentic|key (default agentic), AACP_CHAIN=bsc|base|rh, BAW_BIN
Requires: ${INSTALL_HINT}`);
}

async function main() {
  switch (args[0]) {
    case "status": await cmdStatus(); break;
    case "connect": console.log(JSON.stringify(await connect(), null, 2)); break;
    case "address": console.log(JSON.stringify({ chain: activeChainSlug(), address: await agenticAddress() }, null, 2)); break;
    case "sign-typed": await cmdSignTyped(); break;
    case "send-tx": await cmdSendTx(); break;
    default: help();
  }
}

// Importable as a library (a2a-runtime.mjs / aacp-tx.mjs reuse the functions
// above) and runnable as a CLI — same pattern as a2a-runtime.mjs.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
