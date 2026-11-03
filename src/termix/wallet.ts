import path from "node:path";
import { pathToFileURL } from "node:url";
import { getConfig } from "../config.js";

let signer: { addressFromPrivateKey(k: string): string } | undefined;

/** Wallet address of a hot key, via the skill's vendored signer (the key never leaves the process). */
export async function addressFromKey(key: string): Promise<string> {
  signer ??= (await import(pathToFileURL(path.join(getConfig().termixSkillDir, "scripts", "vendor", "eth-signer.mjs")).href)) as { addressFromPrivateKey(k: string): string };
  return signer.addressFromPrivateKey(key.startsWith("0x") ? key : `0x${key}`);
}
