#!/usr/bin/env node
//
// Termix — browser message-signing bridge (link identity).
//
// A linked terminal cannot personal_sign as the user's web wallet. When a flow
// needs an off-chain signature (NOT a tx), it creates a MESSAGE sign-request, the
// user signs it in the browser `/sign?id=` page, and this returns the signature.
// The backend stamps the derivation `domain` (its frontend host) onto the request;
// the /sign page builds the EXACT bytes for the known messageKind and personal_signs
// them — the terminal never supplies free-form text to sign.
//
// Mirrors aacp-tx.mjs runLinked, but the artifact is a signature, not a txHash.
// Shared by the Quant client (task-wallet derivation) and provider (encryption key).
//
import { loadSessionToken } from "./aacp-credentials.mjs";
import { openInBrowser } from "./aacp-wallet.mjs";
import { resolveWebUrl } from "./aacp-web.mjs";
import { http } from "./a2a-runtime.mjs";
import { pollSignRequest } from "./aacp-sign-poll.mjs";

/**
 * Get the browser web wallet to personal_sign a known `messageKind`.
 * Returns `{ domain, signature }` — `domain` is the backend-stamped frontend host
 * the message was bound to (use it as the HKDF `info` so the terminal reproduces
 * exactly what the browser signed).
 */
export async function signMessageViaBrowser({ chainId, messageKind, action = "sign", title = "Signature request" }) {
  const token = loadSessionToken();
  if (!token) {
    throw new Error(
      "No web session for this backend. Link this terminal first:\n" +
        "  node scripts/aacp-link.mjs start",
    );
  }
  const created = await http("POST", "/api/v1/sign-requests", {
    token,
    body: { chainId, kind: "MESSAGE", messageKind, action, title },
  });
  const item = created.item ?? created;
  const signUrl = resolveWebUrl(item.url);
  process.stderr.write(
    `\n[sign] Your browser web wallet must sign a message (no gas, no transaction).\n` +
      `[sign]   Sign here: ${signUrl}\n`,
  );
  openInBrowser(signUrl);
  process.stderr.write(`[sign]   Waiting for the signature in the browser…\n`);
  const deadline = Date.parse(item.expiresAt) || Date.now() + 15 * 60 * 1000;
  const done = await pollSignRequest({
    deadline,
    read: (signal) => http("GET", `/api/v1/sign-requests/${item.id}`, { token, signal }),
    onRetry: (err) => process.stderr.write(`[sign]   poll failed (${err.message}); retrying\n`),
  });
  if (done.status !== "SUBMITTED" || !done.signatures?.length) {
    throw new Error(`The signature was ${String(done.status).toLowerCase()} in the browser.`);
  }
  return { domain: done.domain, signature: done.signatures[0] };
}
