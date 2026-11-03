#!/usr/bin/env node
//
// Termix Quant — PROVIDER X25519 encryption keypair, per identity.
//
// A quant provider publishes an X25519 public key (`register-key`); clients seal
// their session envelopes to it and the provider decrypts with the private half
// (`inbox --open`, and every `trade`/`autotrade` tick). This is the provider's ONLY
// secret — it never signs on-chain (trades relay-execute with the CLIENT's session
// key embedded in the envelope). The published public key MUST stay stable, or
// in-flight sessions sealed to the old key can no longer be decrypted.
//
// Source of the keypair by identity:
//   key      — HKDF(WALLET_KEY, "termix-quant-x25519-v1")  (UNCHANGED — existing
//              providers keep their published key).
//   agentic  — HKDF(EIP-712 signature) from the Binance Agentic Wallet.
//   link     — HKDF(browser personal_sign) via the MESSAGE sign-request bridge.
//
// For agentic/link the seed is derived from a DETERMINISTIC signature ONCE and then
// cached locally (0600), so day-to-day commands and the unattended worker never
// re-sign; deleting the cache re-derives the SAME key from the wallet (no backup
// needed). ⚠️ agentic re-derivation depends on MPC signature determinism across
// sessions (unverified) — `register-key --verify` checks it, and losing the cache
// under a non-deterministic agentic signature would rotate the key. link (web EOA,
// RFC-6979) is deterministic by spec.
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { activeChain, chainCacheFile } from "./aacp-chain.mjs";
import { activeIdentity, runtimeIdentityFingerprint } from "./aacp-credentials.mjs";
import { signTypedData, walletMode } from "./aacp-wallet.mjs";
import { signMessageViaBrowser } from "./aacp-sign-message.mjs";

// X25519 SPKI/PKCS8 prefixes — frozen (mirror aacp-quant.mjs).
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const privFromSeed = (seed32) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed32]), format: "der", type: "pkcs8" });
const rawOf = (key) => key.export({ type: "spki", format: "der" }).subarray(-32);

const ENC_SALT = "termix-quant-provider-enc-v1";

function fromSeed(seed32) {
  const priv = privFromSeed(seed32);
  return { priv, pubRaw: rawOf(createPublicKey(priv)) };
}

// key mode — byte-identical to aacp-quant's legacy deriveKeypair, so a provider
// that used WALLET_KEY keeps the exact same published key.
function keypairFromWalletKey() {
  const raw = process.env.WALLET_KEY?.trim();
  const hex = raw?.startsWith("0x") ? raw.slice(2) : raw;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("WALLET_KEY must be a 32-byte hex private key.");
  const seed = Buffer.from(hkdfSync("sha256", Buffer.from(hex, "hex"), Buffer.alloc(0), Buffer.from("termix-quant-x25519-v1"), 32));
  return fromSeed(seed);
}

function cachePath() {
  const fp = runtimeIdentityFingerprint().slice(0, 8);
  return resolve(process.cwd(), chainCacheFile(`.termix-quant-enc-${fp}`, ".json"));
}
function loadCachedSeed() {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8"));
    return typeof j.seedHex === "string" ? Buffer.from(j.seedHex, "hex") : null;
  } catch { return null; }
}
function saveCachedSeed(seed) {
  writeFileSync(cachePath(), `${JSON.stringify({ seedHex: Buffer.from(seed).toString("hex") })}\n`, { mode: 0o600 });
}

function seedFromSig(signatureHex, info) {
  const raw = Buffer.from(String(signatureHex).replace(/^0x/, ""), "hex");
  if (raw.length < 64) throw new Error("The wallet returned a non-standard signature (need 65 bytes r‖s‖v).");
  const seed = Buffer.from(hkdfSync("sha256", raw, Buffer.from(ENC_SALT), Buffer.from(info), 32));
  raw.fill(0);
  return seed;
}

/** EIP-712 the agentic wallet signs to seed its provider encryption key. Frozen. */
export function providerEncKeyTypedData({ chainId } = {}) {
  const id = Number(chainId ?? activeChain().chainId);
  return {
    domain: { name: "Termix Quant", version: "1", chainId: id },
    primaryType: "TermixQuantProviderEncKey",
    types: { TermixQuantProviderEncKey: [{ name: "statement", type: "string" }, { name: "version", type: "uint256" }] },
    message: {
      statement: "Derive Termix Quant provider encryption key. Only sign this in the official Termix skill to run a quant strategy for clients.",
      version: 1,
    },
  };
}

async function deriveEncSeed() {
  if (activeIdentity() === "linked") {
    const { domain, signature } = await signMessageViaBrowser({
      chainId: activeChain().chainId,
      messageKind: "QUANT_PROVIDER_ENC_KEY",
      action: "quantProviderKey",
      title: "Derive your Termix Quant provider encryption key",
    });
    return seedFromSig(signature, domain);
  }
  const { signature } = await signTypedData(providerEncKeyTypedData({}), { label: "derive Quant provider encryption key" });
  return seedFromSig(signature, "agentic");
}

/**
 * The provider's X25519 keypair for the active identity. key → WALLET_KEY (sync,
 * unchanged). agentic/link → cached deterministic-signature-derived seed (derives +
 * caches on first use, then reads the cache — no re-signing per command/tick).
 */
export async function resolveEncKeypair() {
  if (activeIdentity() !== "linked" && walletMode() === "key") return keypairFromWalletKey();
  const cached = loadCachedSeed();
  if (cached) return fromSeed(cached);
  const seed = await deriveEncSeed();
  saveCachedSeed(seed);
  return fromSeed(seed);
}

/** Derive fresh from the wallet signature, bypassing the cache — for `--verify`. */
export async function deriveEncKeypairFresh() {
  return fromSeed(await deriveEncSeed());
}

export const encKeyCachePath = cachePath;
