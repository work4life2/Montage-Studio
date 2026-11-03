#!/usr/bin/env node
//
// Termix Quant — WEB-scheme HD task-wallet derivation (link mode, client side).
//
// The browser wizard derives its task wallets from ONE `personal_sign` by the
// login wallet (packages/frontend/lib/quant/task-wallet.ts). In LINK mode the
// terminal acts as that same web account, and the login wallet IS the browser web
// wallet — so the terminal reuses the EXACT web scheme (personal_sign + this salt +
// info=domain + version 3 + the same BIP-44 path), and gets the signature from the
// browser via a MESSAGE sign-request (`/sign?id=`). Result: a linked terminal and
// the website derive BYTE-FOR-BYTE the same task wallets, so a job can be started on
// one and swept from the other.
//
// Distinct from quant-task-wallet.mjs (the AGENTIC scheme, EIP-712 + a different
// salt) — that is a separate set of wallets under the agentic identity.
//
//   sig65  = personal_sign(webTaskWalletDerivationMessage, browser wallet)   (via /sign)
//   seed64 = HKDF-SHA256(ikm=sig65, salt="termix-quant-task-wallet-v1", info=domain)
//   wallet = HDKey.fromMasterSeed(seed64).derive(m/44'/60'/8183'/0/{index})
//
import { hkdfSync } from "node:crypto";
// The HDKey derivation + wipe are identity-agnostic (same path, same HDKey), so
// reuse them from the agentic module rather than duplicate.
export { deriveTaskWallet, deriveTaskWalletAddress, wipeBytes } from "./quant-task-wallet.mjs";

/** Must equal frontend/lib/quant/task-wallet.ts TASK_WALLET_DERIVATION_VERSION. */
export const WEB_TASK_WALLET_DERIVATION_VERSION = 3;
const HKDF_SALT = "termix-quant-task-wallet-v1";

/**
 * The exact string the browser web wallet personal_signs — byte-identical to the
 * web wizard's `taskWalletDerivationMessage`. The `/sign` page builds this itself;
 * this copy exists for tests / a local preview only.
 */
export function webTaskWalletDerivationMessage({ chainId, domain }) {
  return [
    "Termix Quant - derive task wallets",
    `domain: ${domain}`,
    `chainId: ${chainId}`,
    `version: ${WEB_TASK_WALLET_DERIVATION_VERSION}`,
    "",
    "Only sign this on the official Termix site. Any other site asking for this",
    "signature is trying to take control of your trading wallets.",
  ].join("\n");
}

function hexToBytes(hex) {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("Signature is not valid hex");
  }
  return Buffer.from(body, "hex");
}

/**
 * Browser personal_sign (65 bytes) + the derivation `domain` → 64-byte master seed.
 * `domain` is the frontend host the browser signed for (the sign-request's stamped
 * value); it is both in the signed message AND the HKDF `info`, so terminal and web
 * must use the same string — which the backend guarantees by stamping it.
 */
export function deriveSeedFromWebSig(signatureHex, domain) {
  if (!domain) throw new Error("A derivation domain is required (the frontend host the browser signed for).");
  const raw = hexToBytes(signatureHex);
  if (raw.length < 64) {
    throw new Error("The browser returned a non-standard signature (need 65 bytes r‖s‖v). A contract wallet cannot derive task wallets.");
  }
  const seed = Buffer.from(hkdfSync("sha256", raw, Buffer.from(HKDF_SALT), Buffer.from(domain), 64));
  raw.fill(0);
  return seed;
}
