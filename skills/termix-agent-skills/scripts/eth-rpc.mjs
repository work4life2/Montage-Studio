// Minimal JSON-RPC client over fetch for broadcasting signed transactions.
// No viem/ethers — just the handful of methods aacp-tx.mjs needs.
// RPC URL: A2A_RPC_URL env, else the public node for the chain AACP_CHAIN
// selects (see aacp-chain.mjs). Only uses send/receipt/nonce/gas/fee methods
// (no log filters), so public nodes are fine.

import { resolveRpcUrl } from "./aacp-chain.mjs";

export function rpcUrl() {
  return resolveRpcUrl();
}

// Public RPCs intermittently drop connections ("fetch failed", ECONNRESET,
// 5xx, or an HTML error page). Those are transport-level and safe to retry — the
// request never produced a definitive node answer. A JSON-RPC `error` object IS a
// definitive answer (revert, nonce too low, …) and is NEVER retried.
const RPC_RETRIES = Number(process.env.A2A_RPC_RETRIES ?? 3);
const RPC_BACKOFF_MS = [500, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idCounter = 0;
export async function rpc(method, params = [], { retries = RPC_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(rpcUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++idCounter, method, params }),
      });
      if (!res.ok && res.status >= 500) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`RPC ${method}: non-JSON response ${text.slice(0, 200)}`); }
      if (json.error) {
        // Definitive node response — surface it, do not retry.
        const e = new Error(`RPC ${method} error ${json.error.code}: ${json.error.message}`);
        e.rpcError = json.error;
        throw e;
      }
      return json.result;
    } catch (err) {
      // rpcError is definitive; anything else (fetch throw, 5xx, parse) is transient.
      if (err.rpcError || attempt >= retries) throw err;
      lastErr = err;
      process.stderr.write(`[eth-rpc] ${method} transient error (attempt ${attempt + 1}/${retries + 1}): ${err.message.slice(0, 120)} — retrying\n`);
      await sleep(RPC_BACKOFF_MS[Math.min(attempt, RPC_BACKOFF_MS.length - 1)]);
    }
  }
  throw lastErr; // unreachable
}

export const toHex = (v) => "0x" + BigInt(v).toString(16);
export const fromHex = (h) => BigInt(h);

export async function getChainId() {
  return Number(fromHex(await rpc("eth_chainId")));
}

export async function getNonce(address) {
  return fromHex(await rpc("eth_getTransactionCount", [address, "pending"]));
}

// EIP-1559 fees floored to the network's eth_gasPrice so BSC (often near-zero
// base fee but a non-zero min gas price) does not underprice and stall the tx.
// maxFee = max(baseFee*2 + gasPrice, gasPrice); tip = min(gasPrice, maxFee).
export async function getFees() {
  const gp = fromHex(await rpc("eth_gasPrice"));
  let baseFee = 0n;
  try {
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    if (block && block.baseFeePerGas) baseFee = fromHex(block.baseFeePerGas);
  } catch { /* chains without 1559 block field */ }
  let maxFee = baseFee * 2n + gp;
  if (maxFee < gp) maxFee = gp;
  let tip = gp;
  if (tip > maxFee) tip = maxFee;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee };
}

export async function estimateGas({ from, to, value, data }) {
  const tx = { from, to, value: toHex(value ?? 0) };
  if (data && data !== "0x") tx.data = data;
  const est = fromHex(await rpc("eth_estimateGas", [tx]));
  return (est * 12n) / 10n; // +20% buffer
}

// The signed raw tx has a deterministic hash, so broadcasting is idempotent: if a
// prior attempt's response was lost in transit (transport retry) the resend hits an
// "already known / nonce too low" node error — that means our tx already landed, so
// we return the locally-computed hash instead of failing. Pass `knownHash` (the
// value signTransaction returns) to enable this; without it, errors propagate.
const ALREADY_BROADCAST = /already known|known transaction|already exists|nonce too low|replacement transaction underpriced/i;
export async function sendRawTransaction(rawHex, knownHash) {
  try {
    return await rpc("eth_sendRawTransaction", [rawHex]);
  } catch (err) {
    if (knownHash && err.rpcError && ALREADY_BROADCAST.test(err.rpcError.message || "")) {
      process.stderr.write(`[eth-rpc] resend saw "${(err.rpcError.message || "").slice(0, 60)}" — tx already broadcast, using ${knownHash}\n`);
      return knownHash;
    }
    throw err;
  }
}

export async function waitReceipt(txHash, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`receipt timeout for ${txHash} after ${timeoutMs}ms`);
}
