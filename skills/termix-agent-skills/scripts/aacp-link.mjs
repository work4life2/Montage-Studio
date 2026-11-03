#!/usr/bin/env node
//
// Termix — link this terminal to the user's WEB account (docs/link.md).
//
// The user registered on the website with a browser wallet; that is where their
// account, handle and agents live. This command asks that account for an API key
// so the skill can act as it — without a Binance wallet, and without a private
// key — the way `baw auth signin` pairs a CLI with the Binance App:
//
//   start     Print a pairing code, open <site>/link?code=… in the browser, and
//             block until the user approves there (or the code expires).
//             Stores the key locally (0600) and makes `linked` the active identity.
//   status    Is this chain linked, to whom, and is the key still accepted.
//   unlink    Forget the key here. Revoking it for good happens on the website.
//   identity  Show or switch the active identity: `linked` | `agentic`.
//
// What linking changes, and only this: every account-scoped REST call is made
// as the web account. On-chain steps are still signed by the user's own wallet —
// in the browser, via the sign page `aacp-tx.mjs` opens (docs/onchain-tx.md).
//
// Env: AACP_CHAIN / AACP_BASE_URL (each chain is a separate backend, so each is
// linked separately); TERMIX_API_KEY overrides the stored key (CI).
//
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeChain, activeChainSlug, resolveApiBaseUrl } from "./aacp-chain.mjs";
import {
  activeIdentity,
  clearLink,
  identityFilePath,
  isLinkExpiredError,
  linkExpired,
  linkFilePath,
  loadLink,
  previewKey,
  setIdentity,
  writeLink,
} from "./aacp-credentials.mjs";
import { http } from "./a2a-runtime.mjs";
import { openInBrowser } from "./aacp-wallet.mjs";
import { resolveWebUrl } from "./aacp-web.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sibling of SKILL.md; absent in a dev checkout (aacp-update.mjs has the same rule).
function skillVersion() {
  try {
    return readFileSync(fileURLToPath(new URL("../VERSION", import.meta.url)), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// "who is asking" on the approval page. The user matches it against the
// terminal they are sitting at, so user@host is the right level of detail.
function defaultDeviceLabel() {
  let user = "";
  try { user = userInfo().username; } catch { /* some containers have no passwd entry */ }
  return `${user || "terminal"}@${hostname()}`.slice(0, 120);
}

// Same menu the wallet login prints on success. The user has just joined the
// web account and has no idea what is possible from here; see docs/onboarding.md.
const AFTER_LINK = {
  nextSteps: [
    { do: "See what is already waiting on this account", command: "node scripts/aacp-next.mjs", doc: "docs/onboarding.md" },
    { do: "List the agents registered on the website", command: "node scripts/a2a-runtime.mjs agents", doc: "docs/list-agents.md" },
    { do: "Host one of them online so it answers buyers", command: "node scripts/aacp-watch.mjs wait --agent <agentId>", doc: "docs/watch.md" },
    { do: "Publish a request (buyer)", command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders --auth session", doc: "docs/client-publish-brief.md" },
  ],
  tellUser: "Say the terminal is now linked to their Termix web account (name the handle and wallet). Every on-chain step will open a page for them to sign with their web wallet. Then offer these as a short numbered menu in their language; do not run one unasked.",
};

// ── start ───────────────────────────────────────────────────────────────────

async function cmdStart() {
  let existing = loadLink();
  if (existing && !args.includes("--force")) {
    try { await http("GET", "/api/v1/me", { token: existing.apiKey, signal: AbortSignal.timeout(10_000) }); }
    catch (err) {
      if (err.status === 401) existing = null;
      else throw err;
    }
  }
  if (existing && !existing.fromEnv && !linkExpired(existing) && !args.includes("--force")) {
    console.log(JSON.stringify({
      status: "already-linked",
      chain: activeChainSlug(),
      account: { handle: existing.handle, wallet: existing.wallet, id: existing.accountId },
      expiresAt: existing.expiresAt,
      identity: activeIdentity(),
      hint: "Already linked on this chain. `aacp-link.mjs status` verifies the key; `--force` links again (e.g. to a different web account).",
    }, null, 2));
    return;
  }

  const deviceLabel = (typeof arg("label") === "string" && arg("label")) || defaultDeviceLabel();
  const started = await http("POST", "/api/v1/auth/skill-link/start", {
    body: { chainId: activeChain().chainId, deviceLabel, ...(skillVersion() ? { skillVersion: skillVersion() } : {}) },
  });

  const verifyUrl = resolveWebUrl(started.verifyUrl);
  // The code must be shown verbatim: it is what the user matches against the
  // page that opens, and the only thing standing between them and approving a
  // stranger's terminal.
  process.stderr.write(
    `\n[link] Link this terminal to your Termix web account (${activeChain().network})\n` +
    `[link]   Code: ${started.userCode}\n` +
    `[link]   Page: ${verifyUrl}\n`,
  );
  const opened = openInBrowser(verifyUrl);
  process.stderr.write(
    opened
      ? `[link]   Opening that page in your browser…\n`
      : `[link]   Could not open a browser automatically — open the page above yourself (it works from any device).\n`,
  );
  process.stderr.write(
    `[link]   Sign in there with the wallet you registered with, check the code matches, and approve.\n` +
    `[link]   Waiting… (the code expires in about 10 minutes)\n`,
  );

  const intervalMs = Math.max(2, Number(started.intervalSeconds) || 3) * 1000;
  const deadline = Date.parse(started.expiresAt) || Date.now() + 10 * 60 * 1000;
  let lastTick = Date.now();
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let res;
    try {
      res = await http("POST", "/api/v1/auth/skill-link/poll", { body: { pollToken: started.pollToken } });
    } catch (err) {
      // The backend is the source of truth for the code's fate; a transient
      // network error is not it. Keep waiting, say so.
      if (err.status && err.status < 500) throw err;
      process.stderr.write(`[link]   poll failed (${err.message}); retrying\n`);
      continue;
    }
    if (res.status === "PENDING") {
      if (Date.now() - lastTick >= 10_000) {
        lastTick = Date.now();
        process.stderr.write(`[link]   still waiting for your approval on the website… (code ${started.userCode})\n`);
      }
      continue;
    }
    if (res.status === "DENIED") throw new Error("The link was denied on the website. Nothing was stored.");
    if (res.status === "EXPIRED") throw new Error("The code expired before it was approved. Run `start` again for a fresh one.");
    if (res.status === "CLAIMED" && !res.apiKey) {
      // Approved and already claimed — by another poll of ours that lost its
      // reply, or by someone else holding the poll token. Either way this
      // process never saw the key and cannot proceed.
      throw new Error("The link was approved but the key was already collected. Run `start` again.");
    }
    if (res.status === "CLAIMED") {
      writeLink({
        apiKey: res.apiKey,
        accountId: res.account?.id,
        wallet: res.account?.walletAddress,
        handle: res.account?.handle,
        keyId: res.keyId,
        expiresAt: res.expiresAt,
      });
      setIdentity("linked");
      process.stderr.write(`[link] Linked to ${res.account?.handle ? `@${res.account.handle} ` : ""}${res.account?.walletAddress ?? ""} on ${activeChain().network}.\n`);
      console.log(JSON.stringify({
        status: "linked",
        chain: activeChainSlug(),
        api: resolveApiBaseUrl(),
        account: { id: res.account?.id ?? null, handle: res.account?.handle ?? null, wallet: res.account?.walletAddress ?? null },
        expiresAt: res.expiresAt ?? null,
        keyPreview: previewKey(res.apiKey),
        cachedAt: linkFilePath(),
        identity: "linked",
        ...AFTER_LINK,
      }, null, 2));
      return;
    }
    throw new Error(`Unexpected link status ${JSON.stringify(res)}`);
  }
  throw new Error("The code expired before it was approved. Run `start` again for a fresh one.");
}

// ── status ──────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const link = loadLink();
  const base = { chain: activeChainSlug(), api: resolveApiBaseUrl(), identity: activeIdentity() };
  if (!link) {
    console.log(JSON.stringify({
      ...base,
      linked: false,
      hint: "Not linked on this chain. `node scripts/aacp-link.mjs start` links this terminal to the user's Termix web account (no Binance wallet needed).",
    }, null, 2));
    return;
  }
  const out = {
    ...base,
    linked: true,
    account: { id: link.accountId, handle: link.handle, wallet: link.wallet },
    expiresAt: link.expiresAt,
    keyPreview: previewKey(link.apiKey),
    source: link.fromEnv ? "TERMIX_API_KEY env" : linkFilePath(),
  };
  if (args.includes("--offline")) {
    out.verified = false;
    out.expired = linkExpired(link);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  try {
    const me = await http("GET", "/api/v1/me", { token: link.apiKey });
    out.verified = true;
    out.account = { id: me?.id ?? me?.account?.id ?? link.accountId, handle: me?.handle ?? me?.account?.handle ?? link.handle, wallet: me?.walletAddress ?? me?.account?.walletAddress ?? link.wallet };
    out.hint = base.identity === "linked"
      ? "Linked and accepted. `node scripts/aacp-next.mjs` lists what the user can do."
      : "Linked, but the active identity is `agentic`. `node scripts/aacp-link.mjs identity linked` switches back.";
  } catch (err) {
    out.verified = false;
    if (isLinkExpiredError(err)) {
      out.expired = true;
      out.hint = "The key has expired or was revoked on the website. Run `node scripts/aacp-link.mjs start` to link again.";
    } else {
      out.error = err.message;
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

// ── unlink ──────────────────────────────────────────────────────────────────

async function cmdUnlink() {
  const link = loadLink();
  if (!link || link.fromEnv) {
    console.log(JSON.stringify({ status: "not-linked", chain: activeChainSlug(), identity: activeIdentity() }, null, 2));
    return;
  }
  // Best-effort server-side revoke. Key management is wallet-session-only on
  // the backend (a key must not be able to manage keys), so the expected answer
  // is a 403 — the local file goes regardless, and the user finishes on the site.
  let revoked = false;
  let revokeNote = null;
  if (link.keyId) {
    try {
      await http("DELETE", `/api/v1/settings/api-keys/${link.keyId}`, { token: link.apiKey });
      revoked = true;
    } catch (err) {
      revokeNote = err.status === 403 || err.status === 401
        ? "Revoke it on the website: Account → Connected terminals."
        : `Could not reach the backend to revoke (${err.message}). Revoke it on the website: Account → Connected terminals.`;
    }
  }
  clearLink();
  console.log(JSON.stringify({
    status: "unlinked",
    chain: activeChainSlug(),
    removed: linkFilePath(),
    revokedOnServer: revoked,
    ...(revokeNote ? { note: revokeNote } : {}),
    identity: activeIdentity(),
    tellUser: "The terminal no longer holds the key. " + (revoked ? "The key is also revoked." : (revokeNote ?? "")),
  }, null, 2));
}

// ── identity ────────────────────────────────────────────────────────────────

async function cmdIdentity() {
  const want = args[1];
  if (want && !want.startsWith("--")) {
    if (want === "linked" && !loadLink()) {
      throw new Error("No link on this chain yet — run `node scripts/aacp-link.mjs start` first.");
    }
    setIdentity(want);
  }
  const link = loadLink();
  const identity = activeIdentity();
  console.log(JSON.stringify({
    chain: activeChainSlug(),
    identity,
    linked: Boolean(link),
    ...(link ? { account: { handle: link.handle, wallet: link.wallet } } : {}),
    file: identityFilePath(),
    hint: identity === "linked"
      ? "Acting as the web account. On-chain steps open a page for the user's web wallet to sign."
      : link
        ? "Acting with the skill's own wallet (Binance Agentic Wallet / key mode). `identity linked` switches back to the web account."
        : "Acting with the skill's own wallet. `start` links this terminal to the user's web account instead.",
  }, null, 2));
}

function usage(code = 0) {
  process.stderr.write(`Usage: node scripts/aacp-link.mjs <command>

  start [--label <device label>] [--force]
           Link this terminal to the user's Termix WEB account: prints a code,
           opens the approval page, blocks until approved. No wallet, no key.
  status [--offline]
           Linked? To whom? Is the key still accepted by the backend?
  unlink   Forget the key locally (revoke it for good on the website).
  identity [linked|agentic]
           Show or switch which identity the skill acts as.

Env: AACP_CHAIN / AACP_BASE_URL select the backend — each chain is linked
separately. TERMIX_API_KEY overrides the stored key.
`);
  process.exit(code);
}

const COMMANDS = { start: cmdStart, status: cmdStatus, unlink: cmdUnlink, identity: cmdIdentity };

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const run = COMMANDS[command];
  if (!run) {
    if (!["help", "--help", "-h"].includes(command)) process.stderr.write(`Unknown command: ${command}\n`);
    usage(["help", "--help", "-h"].includes(command) ? 0 : 2);
  }
  run().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
