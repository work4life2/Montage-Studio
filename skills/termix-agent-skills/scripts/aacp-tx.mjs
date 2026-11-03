#!/usr/bin/env node
//
// Termix Platform (dev-v2) on-chain tx-intent executor.
//
// Backend "prepare" endpoints return unsigned tx-intents ({contract, callData,
// value, chainId, action}). This script gets them signed and broadcast — the only
// on-chain building block the skill needs. The backend already ABI-encodes
// callData, so no contract ABI is required here.
//
// Who signs depends on the active identity (aacp-credentials.mjs):
//   linked             The terminal is linked to the user's WEB account
//                      (`aacp-link.mjs`). Nothing is signed here: the intents are
//                      handed to the website as a signature request, the page
//                      opens in the browser, the user signs with their web
//                      wallet, and this script waits for the hashes. See docs/link.md.
// Otherwise TERMIX_WALLET_MODE picks the skill's own wallet (docs/wallet-login.md):
//   agentic (default)  The Binance Agentic Wallet signs and broadcasts via `baw`.
//                      Every intent is simulated first; nothing is sent without --yes.
//   key                Sign locally with WALLET_KEY, for operators who do not want
//                      a Binance wallet.
//
// Usage:
//   node aacp-tx.mjs --intent  '<intent-json>'            # agentic: simulate only
//   node aacp-tx.mjs --intent  '<intent-json>' --yes      # agentic: simulate + broadcast
//   node aacp-tx.mjs --intents '<intent-json-array>' --yes  # sequential (e.g. approve+deposit)
//   node aacp-tx.mjs --intent '<json>' --dry-run          # print what would be sent, do NOT broadcast
//   node aacp-tx.mjs --intent '<json>' --context '{"orderId":"…"}'   # linked: shown on the sign page
//
// Intent fields (either naming accepted):
//   to | contract     target address (0x..)
//   data | callData   encoded call (0x.., optional for plain transfers)
//   value             wei as decimal string (default "0")
//   chainId           optional; defaults to the RPC's chain id
//   action            optional label echoed in output
//
// Flags: --dry-run (print the plan, do NOT broadcast), --yes (agentic mode: actually
// broadcast after the simulation; accepted and irrelevant when linked — the user's
// signature in the browser IS the confirmation), --no-wait (skip receipt wait),
// --context '<json>' (linked: business ids the sign page links to).
// To point at a different node, set A2A_RPC_URL (there is no --rpc flag).
//
// Env: TERMIX_WALLET_MODE (agentic|key), WALLET_KEY (key mode only), AACP_CHAIN
//      (bsc|base — selects the RPC alongside the API base), A2A_RPC_URL
//      (optional per-node RPC override).
//
import { pollSignRequest } from "./aacp-sign-poll.mjs";
import { addressFromPrivateKey, signTransaction } from "./vendor/eth-signer.mjs";
import { getChainId, getNonce, getFees, estimateGas, sendRawTransaction, waitReceipt, rpcUrl } from "./eth-rpc.mjs";
import { activeChain, activeChainSlug } from "./aacp-chain.mjs";
import { activeIdentity, isLinkExpiredError, loadLink } from "./aacp-credentials.mjs";
import { http } from "./a2a-runtime.mjs";
import { agenticAddress, executeTx, openInBrowser, previewTx, walletMode } from "./aacp-wallet.mjs";
import { resolveWebUrl } from "./aacp-web.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// `0x` prefix optional — see the same note in a2a-runtime.mjs. Kept identical
// here on purpose: the two entry points must not disagree about what a valid key
// looks like, or `login` succeeds and the broadcast that follows it refuses.
function requireWalletKey() {
  const key = process.env.WALLET_KEY?.trim();
  if (!key) {
    throw new Error(
      "TERMIX_WALLET_MODE=key needs WALLET_KEY to sign and broadcast.\n" +
      "The default is the keyless Binance Agentic Wallet — unset TERMIX_WALLET_MODE and run\n" +
      "`node scripts/aacp-wallet.mjs connect`. See docs/wallet-login.md.",
    );
  }
  const hex = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key;
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error("WALLET_KEY must be a 32-byte hex private key (64 hex chars, `0x` prefix optional).");
  }
  return `0x${hex}`;
}

function normalizeIntent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("intent must be a JSON object");
  const to = raw.to ?? raw.contract;
  const data = raw.data ?? raw.callData ?? "0x";
  if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error(`intent.to/contract is not a valid address: ${to}`);
  return {
    action: raw.action ?? raw.id ?? "tx",
    to,
    data: data || "0x",
    value: String(raw.value ?? "0"),
    chainId: raw.chainId != null ? Number(raw.chainId) : undefined,
  };
}

function parseIntents() {
  const single = arg("intent");
  const multi = arg("intents");
  let list;
  if (typeof multi === "string") {
    const parsed = JSON.parse(multi);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } else if (typeof single === "string") {
    const parsed = JSON.parse(single);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    throw new Error("Provide --intent '<json>' or --intents '<json[]>'");
  }
  return list.map(normalizeIntent);
}

/**
 * Agentic mode: the Binance wallet signs and broadcasts, so this walks the
 * two-step preview → execute flow the wallet requires.
 *
 * Without `--yes` it stops after the simulations. That is the point: the preview
 * carries the balance/allowance/authority changes and the risk flags, and those
 * are what the user is being asked to approve — running them and broadcasting in
 * one breath would make the confirmation theatre.
 *
 * Multi-intent batches (approve + deposit) still run strictly in order and still
 * wait for each receipt on our own RPC before the next preview: the second intent
 * usually only simulates correctly once the first has landed.
 */
async function runAgentic(intents, { yes, noWait }) {
  const from = await agenticAddress();
  const results = [];

  for (const it of intents) {
    if (it.chainId && it.chainId !== activeChain().chainId) {
      throw new Error(
        `intent.chainId ${it.chainId} != AACP_CHAIN=${activeChainSlug()} (${activeChain().chainId}). ` +
          `The intent came from a different chain's backend — set AACP_CHAIN to match it.`,
      );
    }
    const preview = await previewTx({ to: it.to, data: it.data, value: it.value });
    process.stderr.write(`[aacp-tx] preview ${it.action}: ${JSON.stringify({
      parsedTx: preview.parsedTx,
      balanceChanges: preview.balanceChanges,
      allowanceChanges: preview.allowanceChanges,
      authorityChanges: preview.authorityChanges,
      risks: preview.risks,
      riskAddresses: preview.riskAddresses,
    })}\n`);

    if (!yes) {
      results.push({ action: it.action, stage: "preview", ...preview });
      continue;
    }

    const executed = await executeTx(preview.requestId);
    if (!executed.txHash) {
      // PENDING_CONFIRMATION — the hash only exists after the user approves in
      // the App, so stop the batch rather than preview the next intent against a
      // chain state this one has not reached yet.
      results.push({ action: it.action, stage: "pending-app-confirmation", orderId: executed.orderId, message: executed.message });
      console.log(JSON.stringify({ mode: "agentic", from, results }, null, 2));
      throw new Error(
        `${it.action} needs approval in the Binance App (order ${executed.orderId}). ` +
        `Approve it, then find the hash with \`baw wallet tx-history --json\`` +
        `${intents.length > 1 ? " and re-run the remaining intents." : "."}`,
      );
    }

    process.stderr.write(`[aacp-tx] sent ${it.action} tx=${executed.txHash}\n`);
    let status = "submitted";
    let blockNumber = null;
    if (!noWait) {
      const receipt = await waitReceipt(executed.txHash);
      status = receipt.status === "0x1" ? "success" : "reverted";
      blockNumber = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
      if (status === "reverted") {
        results.push({ action: it.action, txHash: executed.txHash, status, blockNumber });
        console.log(JSON.stringify({ mode: "agentic", from, results }, null, 2));
        throw new Error(`tx ${executed.txHash} (${it.action}) reverted on-chain`);
      }
    }
    results.push({ action: it.action, txHash: executed.txHash, status, blockNumber });
  }

  console.log(JSON.stringify({
    mode: "agentic",
    from,
    chainId: activeChain().chainId,
    ...(yes ? {} : { stage: "preview", hint: "Show the simulated changes and risks to the user, then re-run the same command with --yes to broadcast." }),
    results,
  }, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Linked identity: the user's WEB wallet signs, in the browser.
 *
 * The intents become one signature request on the backend; the sign page
 * executes them in order with the user's wallet and reports each hash back.
 * This side only opens the page and waits. There is no local simulation — the
 * page simulates before the wallet prompt, and the wallet itself shows the
 * user what they are signing — which is why `--yes` is not a gate here: the
 * signature IS the yes.
 *
 * Receipts are still awaited on our own RPC, exactly as the other modes do, so
 * the output has the same shape and the same "fails loudly on revert" rule.
 */
async function runLinked(intents, { noWait, context }) {
  const link = loadLink();
  if (!link) throw new Error(`Linked identity selected but no link on chain ${activeChainSlug()}. Run \`node scripts/aacp-link.mjs start\`.`);
  const chainId = activeChain().chainId;
  for (const it of intents) {
    if (it.chainId && it.chainId !== chainId) {
      throw new Error(
        `intent.chainId ${it.chainId} != AACP_CHAIN=${activeChainSlug()} (${chainId}). ` +
          `The intent came from a different chain's backend — set AACP_CHAIN to match it.`,
      );
    }
  }
  const actions = intents.map((it) => it.action);
  let created;
  try {
    created = await http("POST", "/api/v1/sign-requests", {
      token: link.apiKey,
      body: {
        chainId,
        action: actions[actions.length - 1],
        title: `${actions.join(" + ")} on ${activeChain().network}`,
        ...(context ? { context } : {}),
        intents: intents.map((it) => ({ contract: it.to, callData: it.data, value: it.value, chainId, action: it.action })),
      },
    });
  } catch (err) {
    if (isLinkExpiredError(err)) throw new Error("The web-account link is expired or revoked. Run `node scripts/aacp-link.mjs start` to link again, then re-run this.");
    throw err;
  }
  const req = created.item ?? created;
  const signUrl = resolveWebUrl(req.url);

  process.stderr.write(
    `\n[sign] ${actions.join(" + ")} needs the user's web wallet.\n` +
    `[sign]   Sign here: ${signUrl}\n`,
  );
  const opened = openInBrowser(signUrl);
  process.stderr.write(
    opened
      ? `[sign]   Opening that page in your browser…\n`
      : `[sign]   Could not open a browser automatically — open the page above yourself.\n`,
  );
  process.stderr.write(
    `[sign]   It is also listed under the pending-signatures badge on the website.\n` +
    `[sign]   Waiting for the signature… (the request expires ${req.expiresAt ? `at ${req.expiresAt}` : "in about 15 minutes"})\n`,
  );

  // Ctrl-C while waiting: tell the backend so the page stops offering it. Also
  // SIGTERM/SIGHUP — agent hosts stop a hung tool that way, and a request left
  // PENDING would keep showing under the website badge until it expires.
  const onInterrupt = () => {
    process.stderr.write(`\n[sign] cancelling request ${req.id}…\n`);
    http("POST", `/api/v1/sign-requests/${req.id}/cancel`, { token: link.apiKey, signal: AbortSignal.timeout(5000) })
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onInterrupt);

  const deadline = req.expiresAt ? Date.parse(req.expiresAt) + 30_000 : Date.now() + 16 * 60 * 1000;
  let lastTick = Date.now();
  let item;
  try {
    item = await pollSignRequest({
      deadline,
      read: (signal) => http("GET", `/api/v1/sign-requests/${req.id}`, { token: link.apiKey, signal }),
      onRetry: (err) => process.stderr.write(`[sign]   poll failed (${err.message}); retrying\n`),
      onPending: (pending) => {
        if (Date.now() - lastTick >= 10_000) {
          lastTick = Date.now();
          const done = (pending.txHashes ?? []).length;
          process.stderr.write(`[sign]   still waiting for the signature in the browser... ${done ? `(${done}/${intents.length} sent) ` : ""}${signUrl}\n`);
        }
      },
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, onInterrupt);
  }

  const out = { mode: "linked", from: link.wallet, chainId, signRequestId: req.id, url: signUrl };
  if (item.status !== "SUBMITTED" && item.txHashes?.length) {
    console.log(JSON.stringify({ ...out, status: item.status, results: item.txHashes.map((txHash, i) => ({ action: intents[i].action, txHash, status: "submitted", blockNumber: null })) }, null, 2));
    process.stderr.write("[sign] Some transactions were already sent. Check their receipts before retrying.\n");
  }
  if (item.status === "REJECTED") throw new Error(`The user declined ${actions.join(" + ")} in the browser (sign request ${req.id}).`);
  if (item.status === "FAILED") throw new Error(`The browser could not broadcast ${actions.join(" + ")}: ${item.error ?? "unknown error"} (sign request ${req.id}).`);
  if (item.status === "CANCELLED") throw new Error(`Sign request ${req.id} was cancelled.`);
  if (item.status === "EXPIRED") throw new Error("Nobody signed within 15 minutes; re-run to create a new request.");
  if (item.status !== "SUBMITTED") throw new Error(`Unexpected sign request status ${item.status}`);

  const results = [];
  for (let i = 0; i < intents.length; i += 1) {
    const it = intents[i];
    const txHash = item.txHashes[i];
    process.stderr.write(`[aacp-tx] signed ${it.action} tx=${txHash}\n`);
    let status = "submitted";
    let blockNumber = null;
    if (!noWait) {
      const receipt = await waitReceipt(txHash);
      status = receipt.status === "0x1" ? "success" : "reverted";
      blockNumber = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
      if (status === "reverted") {
        results.push({ action: it.action, txHash, status, blockNumber });
        console.log(JSON.stringify({ ...out, results }, null, 2));
        throw new Error(`tx ${txHash} (${it.action}) reverted on-chain`);
      }
    }
    results.push({ action: it.action, txHash, status, blockNumber });
  }
  console.log(JSON.stringify({ ...out, results }, null, 2));
}

function parseContext() {
  const raw = arg("context");
  if (typeof raw !== "string") return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--context must be a JSON object");
  return parsed;
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("Usage: node aacp-tx.mjs --intent '<json>' [--intents '<json[]>'] [--yes] [--dry-run] [--no-wait] [--context '<json>']\n");
    return;
  }
  const intents = parseIntents();
  const dryRun = args.includes("--dry-run");
  const noWait = args.includes("--no-wait");
  const yes = args.includes("--yes");
  const context = parseContext();
  // Linked wins over TERMIX_WALLET_MODE: the web wallet signs, whatever the
  // skill's own wallet would have been.
  const linked = activeIdentity() === "linked";
  const mode = linked ? "linked" : walletMode();

  // Summary (always printed first so the operator/LLM can confirm before broadcast).
  const summary = intents.map((it) => ({ action: it.action, to: it.to, value: it.value, dataLen: (it.data.length - 2) / 2 }));
  // Name the chain, not just the RPC host: broadcasting to the wrong network is
  // the expensive mistake here, and this line is what the operator confirms.
  process.stderr.write(
    `[aacp-tx] mode=${mode} chain=${activeChainSlug()} (${activeChain().network}) rpc=${rpcUrl()} intents=${intents.length}\n`,
  );
  process.stderr.write(`[aacp-tx] plan=${JSON.stringify(summary)}\n`);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          mode,
          from: linked ? loadLink()?.wallet ?? null : mode === "agentic" ? await agenticAddress().catch(() => null) : null,
          chain: activeChainSlug(),
          chainId: activeChain().chainId,
          rpc: rpcUrl(),
          intents: summary,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (linked) {
    await runLinked(intents, { noWait, context });
    return;
  }

  if (mode === "agentic") {
    await runAgentic(intents, { yes, noWait });
    return;
  }

  const pk = requireWalletKey();
  const from = addressFromPrivateKey(pk);
  const rpcChainId = await getChainId();
  let nonce = await getNonce(from);
  const results = [];

  for (const it of intents) {
    const chainId = it.chainId ?? rpcChainId;
    if (it.chainId && it.chainId !== rpcChainId) {
      // Almost always means the API and the RPC are pointed at different chains.
      // AACP_CHAIN sets both together; naming the resolved chain here saves the
      // operator from guessing which half is wrong.
      throw new Error(
        `intent.chainId ${it.chainId} != RPC chainId ${rpcChainId} — the backend and the RPC are on different chains. ` +
          `Currently AACP_CHAIN=${activeChainSlug()} (${activeChain().network}, RPC ${rpcUrl()}). ` +
          `Set AACP_CHAIN to the chain this intent came from, or override A2A_RPC_URL.`,
      );
    }
    const fees = await getFees();
    const gas = await estimateGas({ from, to: it.to, value: it.value, data: it.data });
    const signed = signTransaction(pk, {
      chainId,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gas,
      to: it.to,
      value: it.value,
      data: it.data,
    });
    const txHash = await sendRawTransaction(signed.raw, signed.hash);
    process.stderr.write(`[aacp-tx] sent ${it.action} nonce=${nonce} tx=${txHash}\n`);
    let status = "submitted";
    let blockNumber = null;
    if (!noWait) {
      const receipt = await waitReceipt(txHash);
      status = receipt.status === "0x1" ? "success" : "reverted";
      blockNumber = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
      if (status === "reverted") {
        results.push({ action: it.action, txHash, status, blockNumber });
        console.log(JSON.stringify({ from, results }, null, 2));
        throw new Error(`tx ${txHash} (${it.action}) reverted on-chain`);
      }
    }
    results.push({ action: it.action, txHash, status, blockNumber, nonce: Number(nonce) });
    nonce += 1n;
  }

  console.log(JSON.stringify({ from, chainId: rpcChainId, results }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
