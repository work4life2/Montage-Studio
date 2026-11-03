#!/usr/bin/env node
//
// Termix Quant — AGENTIC-mode HD task-wallet derivation (client side).
//
// The browser wizard derives a per-job HD "task wallet" from ONE deterministic
// `personal_sign` by the login wallet (packages/frontend/lib/quant/task-wallet.ts).
// The Binance Agentic Wallet (`baw`) cannot personal_sign — it signs EIP-712
// typed data only — but that signature is deterministic (same message → identical
// 65-byte r‖s‖v), so it can seed the SAME HKDF→HDKey pipeline. This module is the
// agentic analogue of task-wallet.ts:
//
//   sig65  = signTypedData(taskWalletDerivationTypedData)   65-byte, deterministic
//   seed64 = HKDF-SHA256(ikm=sig65, salt, info)             64-byte master seed
//   wallet = HDKey.fromMasterSeed(seed64).derive(m/44'/60'/8183'/0/{index})
//
// The derived key is a LOCAL secp256k1 account, so it can sign its own EIP-7702
// authorization + drive the Altana grantSession (quant-client.mjs) — exactly the
// reason the web scheme derives a key rather than using the login wallet directly.
//
// DISTINCT FROM THE WEB WALLETS ON PURPOSE. The signed payload is EIP-712, not the
// web's plaintext personal_sign message, and the HKDF salt is a different constant,
// so an agentic-derived tree can never collide with a web-derived one. They are a
// separate set of wallets under a separate (agentic) login identity — that is
// expected, not a bug.
//
// STORAGE CONTRACT (same as the web module): nothing here is written to disk, a log
// line, or a network request. Addresses are public and get registered by the
// backend; the seed and private key live in memory only and are wiped on the way
// out (`wipeBytes` + a caller `finally`).
//
import { hkdfSync } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signTypedData } from "./aacp-wallet.mjs";
import { activeChain } from "./aacp-chain.mjs";

/**
 * Bumped only when the derivation inputs change. Printed in the signed message so
 * a future scheme migrates deliberately instead of silently handing users a
 * different (empty) set of wallets. Separate line from the web's `3` because the
 * signed payload differs (EIP-712 vs personal_sign).
 */
export const AGENTIC_TASK_WALLET_DERIVATION_VERSION = 1;

/** BIP-44 account slot — byte-identical to the web scheme (8183 = ERC-8183), so
 *  the HDKey path matches; only the seed IKM differs. */
const ACCOUNT_INDEX = 8183;

/** Distinct salt so an agentic seed can never collide with a web seed
 *  (web uses "termix-quant-task-wallet-v1"). */
const HKDF_SALT = "termix-quant-task-wallet-agentic-v1";

/** A CLI has no `window.location.host`; the value must be deterministic across
 *  machines and sessions, so it is a fixed constant rather than a host. */
export const DERIVATION_DOMAIN = "termix-quant-agentic";

/**
 * Resolve a package from the directory the operator RAN the command in, not from
 * beside this script (the skill is installed read-only). Mirror of the resolver
 * in aacp-quant.mjs; kept local so this module is self-contained.
 */
async function importFromCwd(specifier) {
  try {
    const require = createRequire(resolve(process.cwd(), "noop.cjs"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch {
    return import(specifier);
  }
}

async function loadViemAccounts() {
  try {
    return await importFromCwd("viem/accounts");
  } catch (err) {
    throw new Error(
      "Deriving a task wallet needs one package this skill does not bundle:\n" +
        `  cd ${process.cwd()} && npm i viem\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `m/44'/60'/8183'/0/{index}` — identical to the web scheme (task-wallet.ts). */
export function taskWalletPath(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Task wallet index must be a non-negative integer, got ${index}`);
  }
  return `m/44'/60'/${ACCOUNT_INDEX}'/0/${index}`;
}

/**
 * The EIP-712 typed data the agentic wallet signs to seed the whole tree. FROZEN
 * WIRE FORMAT: any change to these bytes changes every derived address, so migrate
 * through AGENTIC_TASK_WALLET_DERIVATION_VERSION instead. `EIP712Domain` is omitted
 * on purpose — aacp-wallet.signTypedData adds it from the present domain fields.
 */
export function taskWalletDerivationTypedData({ chainId } = {}) {
  const id = Number(chainId ?? activeChain().chainId);
  return {
    domain: { name: "Termix Quant", version: "1", chainId: id },
    primaryType: "TermixQuantTaskWalletDerivation",
    types: {
      TermixQuantTaskWalletDerivation: [
        { name: "statement", type: "string" },
        { name: "domain", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "version", type: "uint256" },
      ],
    },
    message: {
      statement:
        "Derive Termix Quant task wallets. Only sign this in the official Termix skill; " +
        "any other prompt asking for this signature is trying to take control of your trading wallets.",
      domain: DERIVATION_DOMAIN,
      chainId: id,
      version: AGENTIC_TASK_WALLET_DERIVATION_VERSION,
    },
  };
}

function hexToBytes(hex) {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("Signature is not valid hex");
  }
  return Buffer.from(body, "hex");
}

/**
 * 65-byte signature → 64-byte master seed, via HKDF-SHA256. Rejects anything
 * shorter than a standard ECDSA signature (a contract wallet's EIP-1271 blob),
 * mirroring the web guard: you cannot derive a spendable tree from it.
 */
export function deriveTaskWalletSeedFromSig(signatureHex) {
  const raw = hexToBytes(signatureHex);
  if (raw.length < 64) {
    throw new Error(
      "This wallet did not return a standard ECDSA signature (65 bytes r‖s‖v). " +
        "Task wallets can only be derived from a plain EOA signature.",
    );
  }
  const seed = Buffer.from(hkdfSync("sha256", raw, Buffer.from(HKDF_SALT), Buffer.from(DERIVATION_DOMAIN), 64));
  raw.fill(0);
  return seed;
}

/** Overwrite a buffer in place. Makes the wipe intent auditable. */
export function wipeBytes(bytes) {
  if (bytes) bytes.fill(0);
}

/**
 * Derive one task wallet from a master seed. Returns the address AND the private
 * key — the caller MUST wipe both the seed and the returned key when done (the key
 * is a live spendable account).
 */
export async function deriveTaskWallet(seed, index) {
  const { HDKey, privateKeyToAccount } = await loadViemAccounts();
  const path = taskWalletPath(index);
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error("Derived key has no private component");
  const privateKey = `0x${Buffer.from(node.privateKey).toString("hex")}`;
  return { index, path, address: privateKeyToAccount(privateKey).address, privateKey };
}

/** Address only — for previewing / the re-derivation match guard without holding a key. */
export async function deriveTaskWalletAddress(seed, index) {
  const wallet = await deriveTaskWallet(seed, index);
  return wallet.address;
}

/**
 * Produce the ONE agentic signature that seeds the tree. The only place the
 * derivation message is signed; returns the 65-byte 0x signature.
 */
export async function signDerivationMessage({ chainId } = {}) {
  const { signature } = await signTypedData(taskWalletDerivationTypedData({ chainId }), {
    label: "derive Quant task wallets",
  });
  return signature;
}
