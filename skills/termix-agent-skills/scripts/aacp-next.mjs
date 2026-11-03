#!/usr/bin/env node
//
// Termix — "where am I, and what can I do next?" (docs/onboarding.md)
//
// THE POINT: a freshly installed skill is a wall of capability with no door.
// The operator does not know that logging in is step one, that publishing a
// request needs an owned agent, or that hosting is a loop they have to ask for.
// Every one of those is knowable from state, so this script reads the state —
// wallet, session, owned agents, work in flight — and returns a SHORT ordered
// menu of what to do next, with the exact command for each.
//
//   node aacp-next.mjs                 full probe (wallet + backend)
//   node aacp-next.mjs --offline       skip every network/CLI call (stage from caches only)
//   node aacp-next.mjs --skip-wallet   skip the `baw` probe (it can take a second)
//
// Everything degrades: a missing `baw`, an expired session and an unreachable
// backend are all STATES with their own next step, never a stack trace. The
// caller is an agent about to speak to a human; handing it an exception instead
// of a menu is how the human ends up staring at a prompt with nothing to do.
//
// Read-only and unauthenticated where it can be. No signing, no writes, ever.
//
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeChain, activeChainSlug, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, isLinkExpiredError, linkExpired, loadLink } from "./aacp-credentials.mjs";
import { http, loadCachedToken, loadSessionToken, providerOrdersAwaiting } from "./a2a-runtime.mjs";
import { walletMode } from "./aacp-wallet.mjs";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const SKIP_WALLET = args.includes("--skip-wallet") || OFFLINE;

function installedVersion() {
  try {
    return readFileSync(fileURLToPath(new URL("../VERSION", import.meta.url)), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// ── probes ──────────────────────────────────────────────────────────────────
//
// Each returns a plain object and never throws. A probe that cannot answer says
// so in its own shape (`error`), because "we could not check" and "it is not
// set up" lead to different advice.

// Is this terminal linked to the user's web account (docs/link.md)? Decided
// from the local files only — whether the key is still ACCEPTED is what
// probeSession finds out, since the same GET /me answers both questions.
function probeLink() {
  const identity = activeIdentity();
  const link = loadLink();
  if (!link) return { identity, linked: false };
  return {
    identity,
    linked: true,
    account: { id: link.accountId, handle: link.handle, wallet: link.wallet },
    expiresAt: link.expiresAt,
    // Only what the file says; the backend has the last word (see probeSession).
    expiredLocally: linkExpired(link),
    source: link.fromEnv ? "TERMIX_API_KEY" : "file",
  };
}

async function probeWallet(link) {
  // Linked: the user's web wallet signs in the browser, so the skill's own
  // wallet is not on the path at all. Probing `baw` here would only produce a
  // blocker for something the user does not need.
  if (link.identity === "linked") return { mode: "linked", status: "SKIPPED", reason: "linked to the web account — the Binance wallet is not used" };
  let mode;
  try {
    mode = walletMode();
  } catch (err) {
    // An unknown TERMIX_WALLET_MODE is a typo in the operator's env, and it
    // would otherwise surface much later as a failed signature.
    return { mode: "invalid", error: err.message };
  }
  if (mode === "key") {
    return { mode, keyPresent: Boolean(process.env.WALLET_KEY?.trim()) };
  }
  if (SKIP_WALLET) return { mode, status: "SKIPPED" };
  try {
    const wallet = await import("./aacp-wallet.mjs");
    const status = await wallet.walletStatus();
    if (status !== "CONNECTED") return { mode, status };
    const address = await wallet.agenticAddress().catch(() => null);
    // `wallet settings` is the only source for Developer Mode, and it being off
    // is the single most common reason a first signature hangs then fails.
    const settings = await wallet.bawJson(["wallet", "settings"]).catch(() => null);
    return {
      mode,
      status,
      address,
      devMode: settings?.devMode ? Boolean(settings.devMode.enabled) : null,
    };
  } catch (err) {
    // "Not installed" and "could not tell" are different answers. The adapter
    // turns ENOENT into its own install message; anything else (a CLI that
    // cannot reach Binance, a timeout) is an inconclusive probe, and treating
    // it as "not installed" would send a fully set-up operator back to step one.
    const missing = /is not installed/.test(err.message);
    return { mode, status: missing ? "CLI_MISSING" : "PROBE_FAILED", error: err.message };
  }
}

async function probeSession(link) {
  const linked = link.identity === "linked";
  const token = loadSessionToken();
  if (!token) return { loggedIn: false, via: linked ? "link" : "wallet" };
  if (OFFLINE) return { loggedIn: true, verified: false, via: linked ? "link" : "wallet", ...(linked && link.expiredLocally ? { expired: true } : {}) };
  try {
    const me = await http("GET", "/api/v1/me", { token });
    return {
      loggedIn: true,
      verified: true,
      via: linked ? "link" : "wallet",
      accountId: me?.id ?? me?.account?.id ?? null,
      handle: me?.handle ?? me?.account?.handle ?? null,
      wallet: me?.walletAddress ?? me?.account?.walletAddress ?? null,
    };
  } catch (err) {
    // A cached token that the backend rejects is worse than no token: every
    // later call fails with a 401 the operator has no reason to connect to
    // "log in again". Name it here instead. For a link the cure is different
    // (link again on the website), so keep the two apart.
    if (err.status === 401) return { loggedIn: false, expired: true, via: linked ? "link" : "wallet", ...(linked && isLinkExpiredError(err) ? { linkExpired: true } : {}) };
    return { loggedIn: true, verified: false, via: linked ? "link" : "wallet", error: err.message };
  }
}

async function probeAgents(session) {
  if (!session.loggedIn || OFFLINE) return null;
  try {
    const res = await http("GET", "/api/v1/agents", { token: loadSessionToken() });
    const items = (res.items ?? []).map((a) => ({
      agentId: a.id,
      agentTokenId: a.agentTokenId,
      name: a.name,
      a2aStatus: a.a2aStatus,
    }));
    return { count: items.length, online: items.filter((a) => a.a2aStatus === "ONLINE").length, items: items.slice(0, 10) };
  } catch (err) {
    return { error: err.message };
  }
}

// Binance Agent IDs (`.ai`, SPACE ID) the signed-in wallet holds, and whether each
// is already this account's agent. An Agent ID IS an AACP agent (the contracts
// resolve it through AgentIdentityRouter), so using one is an off-chain activation,
// not a mint. Only the skill's own wallet can hold one — a linked web wallet never
// does, so it is not probed.
//
// `available` is false where no Agent ID registry exists (testnet / Base / RH) —
// never send those users to the Binance App. `unindexed` items are IDs the chain
// says the wallet holds but the backend has not projected yet (name unknown).
async function probeExternalIds(session, link) {
  if (!session.loggedIn || OFFLINE || link.identity === "linked") return null;
  try {
    const res = await http("GET", "/api/v1/me/agent-ids", { token: loadSessionToken() });
    return {
      available: res.available !== false,
      items: (res.items ?? []).map((x) => ({ provider: x.provider, name: x.name, displayName: x.displayName, tokenId: x.tokenId, agentId: x.agentId, unindexed: Boolean(x.unindexed) })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// What is already waiting for a decision. This is what turns a generic menu
// ("you could publish a request…") into the one thing that actually matters
// right now ("a buyer funded an order — it needs delivering").
async function probeWork(session) {
  if (!session.loggedIn || OFFLINE) return null;
  const token = loadSessionToken();
  const work = { fundedOrders: 0, openRequests: 0, activeOffers: 0 };
  await Promise.all([
    providerOrdersAwaiting((path) => http("GET", path, { token }))
      .then((orders) => {
        work.fundedOrders = orders.length;
        work.pendingAccept = orders.filter((o) => o.status === "PENDING_ACCEPT").length;
      })
      .catch((err) => { work.ordersError = err.message; }),
    http("GET", "/api/v1/prepayment-orders", { token })
      .then((res) => {
        const briefs = Array.isArray(res) ? res : res.items ?? [];
        for (const brief of briefs) {
          if (brief.acceptedOfferId) continue;
          work.openRequests += 1;
          // Only ACTIVE offers are a live decision — the rest are history.
          work.activeOffers += (brief.offers ?? []).filter((o) => !o.status || o.status === "ACTIVE").length;
        }
      })
      .catch((err) => { work.offersError = err.message; }),
  ]);
  return work;
}

// ── the menu ────────────────────────────────────────────────────────────────
//
// One stage at a time. Onboarding fails when everything is offered at once, so
// a blocked stage returns ONLY the unblocking step; the fan-out of "publish /
// take work / host" is reached exactly once, when it is all genuinely possible.

const BROWSE_STEP = {
  do: "Browse the marketplace (no login needed)",
  why: "Works before any setup — see who is on Termix and what they charge.",
  command: "node scripts/aacp-agent.mjs <name-or-keyword>",
  doc: "docs/list-agents.md",
};

// The recommended way in. Someone who registered on the website already has an
// account and agents there; linking makes this terminal act as that account and
// needs no Binance wallet — every on-chain step is signed in the browser instead.
const LINK_STEP = {
  do: "Link this terminal to your Termix web account (recommended)",
  why: "Uses the account and agents you already registered on the website. No Binance wallet or private key here; on-chain steps open a page for your web wallet to sign.",
  command: "node scripts/aacp-link.mjs start",
  doc: "docs/link.md",
};

/**
 * The wallet problem standing between this operator and their first signature,
 * or null. Kept separate from the plan because it is a BLOCKER only before
 * login: a valid session is itself proof that signing worked once, and someone
 * who is signed in with agents and orders must not be sent back to step one
 * because a `baw` probe timed out. After login the same problem is a warning,
 * surfaced when it matters — the next on-chain action.
 */
function walletBlocker(wallet) {
  if (wallet.mode === "invalid") {
    return {
      stage: "wallet-mode-invalid",
      summary: "TERMIX_WALLET_MODE is set to something this skill does not understand.",
      steps: [{
        do: "Fix or unset TERMIX_WALLET_MODE",
        why: wallet.error,
        command: "unset TERMIX_WALLET_MODE   # back to the default keyless wallet",
        doc: "docs/wallet-login.md",
      }],
    };
  }
  if (wallet.mode === "key" && !wallet.keyPresent) {
    return {
      stage: "wallet-key-missing",
      summary: "Key mode is selected but WALLET_KEY is not set.",
      steps: [{
        do: "Set WALLET_KEY, or switch back to the keyless Binance Agentic Wallet",
        why: "Key mode signs locally and needs the owner's private key; the default mode needs no key at all.",
        command: "unset TERMIX_WALLET_MODE && node scripts/aacp-wallet.mjs connect",
        doc: "docs/wallet-login.md",
      }, BROWSE_STEP],
    };
  }
  if (wallet.mode === "agentic" && wallet.status === "CLI_MISSING") {
    return {
      stage: "wallet-cli-missing",
      summary: "The Binance Agentic Wallet CLI is not installed yet — that is the keyless way in.",
      steps: [{
        do: "Install the wallet CLI, then connect",
        why: "It signs on your phone, so no private key is ever pasted into a shell or a chat.",
        command: "npm install -g @binance/agentic-wallet && node scripts/aacp-wallet.mjs connect",
        doc: "docs/wallet-login.md",
      }, BROWSE_STEP],
    };
  }
  // PROBE_FAILED is deliberately not a blocker: we could not tell, and guessing
  // "broken" costs more than guessing "fine" — the real signing attempt reports
  // its own error, with far better detail than a probe.
  if (wallet.mode === "agentic" && !["CONNECTED", "SKIPPED", "PROBE_FAILED"].includes(wallet.status)) {
    return {
      stage: "wallet-disconnected",
      summary: `The Binance wallet is not signed in (status ${wallet.status}).`,
      steps: [{
        do: "Connect the wallet",
        why: "Prints a pairing code and waits while you confirm in the Binance App. One time only.",
        command: "node scripts/aacp-wallet.mjs connect",
        doc: "docs/wallet-login.md",
      }, BROWSE_STEP],
    };
  }
  if (wallet.mode === "agentic" && wallet.status === "CONNECTED" && wallet.devMode === false) {
    return {
      stage: "wallet-devmode-off",
      summary: "The wallet is connected but Developer Mode is off, so no signature will go through.",
      steps: [{
        do: "Enable Developer Mode in the Binance App, then re-check",
        why: "Only the App can turn it on. Login, runtime tokens and transactions all need it.",
        command: "node scripts/aacp-wallet.mjs status",
        doc: "docs/wallet-login.md",
      }],
    };
  }
  return null;
}

function planFor({ wallet, session, agents, work, externalIds, link = { identity: "agentic", linked: false } }) {
  const linked = link.identity === "linked";

  // A linked terminal whose key the backend no longer accepts (expired, or
  // revoked on the website). Nothing else can be done until it is linked again,
  // and "log in" would be the wrong advice — that is the other identity.
  if (linked && session.expired) {
    return {
      stage: "link-expired",
      summary: `The link to the web account${link.account?.handle ? ` @${link.account.handle}` : ""} has expired or was revoked on the website.`,
      steps: [{
        do: "Link this terminal again",
        why: "Opens the approval page; the user signs in with their web wallet and approves. Nothing is spent.",
        command: "node scripts/aacp-link.mjs start",
        doc: "docs/link.md",
      }, {
        do: "Or use the skill's own wallet instead",
        why: "Switches to the Binance Agentic Wallet identity (a separate account with its own agents).",
        command: "node scripts/aacp-link.mjs identity agentic",
        doc: "docs/link.md",
      }, BROWSE_STEP],
    };
  }

  // Linked: no wallet stage at all — the web wallet signs in the browser.
  const blocker = linked ? null : walletBlocker(wallet);
  // Before login the wallet IS the next step. After login it is only a warning,
  // attached below to the steps that actually need a signature.
  if (!session.loggedIn && blocker) {
    // Offer the web-account link first: it sidesteps the whole wallet setup.
    return { ...blocker, steps: [LINK_STEP, ...blocker.steps], linkAvailable: true };
  }
  const walletWarning = blocker
    ? `Signing is currently blocked (${blocker.stage}): ${blocker.steps[0].do}. Anything on-chain will fail until that is fixed.`
    : null;

  if (!session.loggedIn) {
    return {
      stage: session.expired ? "session-expired" : "logged-out",
      summary: session.expired
        ? "The cached session has expired — sign in again."
        // Only claim the wallet is ready when it was actually looked at.
        : wallet.status === "SKIPPED"
          ? "Not signed in to Termix yet."
          : "Wallet is ready. You are not signed in to Termix yet.",
      steps: [LINK_STEP, {
        do: "Or log in with the skill's own wallet",
        why: "Signs a nonce with the connected Binance wallet and caches a session. A standalone account — it cannot see the agents or orders on the website, and shares nothing with the web wallet. Nothing is spent.",
        command: "node scripts/a2a-runtime.mjs login",
        doc: "docs/wallet-login.md",
      }, BROWSE_STEP],
      linkAvailable: true,
    };
  }

  // Signed in with the skill's own wallet while a link also exists on this chain
  // (the user switched identities on purpose): say so, do not nag.
  const identityNote = !linked && link.linked
    ? "Acting with the skill's own wallet; the web-account link is set aside. `node scripts/aacp-link.mjs identity linked` switches back."
    : null;
  const withPrefix = (summary) => (linked ? `Linked to the web account${session.handle ? ` @${session.handle}` : ""}. ${summary}` : summary);

  const idItems = Array.isArray(externalIds?.items) ? externalIds.items : [];
  const idleIds = idItems.filter((x) => !x.agentId && !x.unindexed);
  const unindexedId = idItems.find((x) => x.unindexed);
  const activateStep = (x) => ({
    do: `Use your Binance Agent ID ${x.displayName} as your agent`,
    why: `${x.displayName} itself becomes your Termix agent — buyers find it by that name and payouts go to this wallet. No transaction, no gas: it only creates the profile. The Agent ID carries just a name and an image, so before activating offer the optional profile — display name, description, category, tags, the same fields as a minted agent, kept on Termix only — and offer to draft it from what the user says the agent does. Set at activation only.`,
    command: `node scripts/aacp-api.mjs POST /api/v1/agents/activate --body '{"provider":"${x.provider}","name":"${x.name ?? ""}"${x.name ? "" : `,"tokenId":"${x.tokenId}"`}}'`,
    doc: "docs/binance-agent-id.md",
  });
  const activateByNameStep = (x) => ({
    do: "Use your Binance Agent ID as your agent — ask the user for its .ai name",
    why: "The chain shows this wallet holds an Agent ID that Termix has not indexed yet (it was just claimed, or indexing is catching up). With its name it can be activated right now — free, no transaction.",
    command: `node scripts/aacp-api.mjs POST /api/v1/agents/activate --body '{"provider":"${x.provider}","name":"<name, without .ai>"}'`,
    doc: "docs/binance-agent-id.md",
  });
  const MINT_INSTEAD = {
    do: "Or skip it and mint an ERC-8004 agent instead",
    why: "Works without an Agent ID; the agent gets a <name>.agent handle. Costs one gas fee.",
    command: "node scripts/aacp-api.mjs GET /api/v1/config/contracts --auth none",
    doc: "docs/provider-create-agent.md",
  };

  // Binance Agentic Wallet, no agent yet: the Agent ID comes FIRST. It is free, it
  // is the user's identity in the Binance ecosystem, and on Termix it IS the agent
  // (no mint) — so lead with claiming / activating it before anything else.
  if (agents && !agents.error && agents.count === 0 && !linked) {
    if (idleIds[0]) {
      return {
        stage: "agent-id-unactivated",
        summary: `Signed in. This wallet holds the Binance Agent ID ${idleIds[0].displayName} — it can be your Termix agent right away.`,
        steps: [activateStep(idleIds[0]), MINT_INSTEAD, BROWSE_STEP],
        warning: walletWarning ?? identityNote,
      };
    }
    if (unindexedId) {
      return {
        stage: "agent-id-unindexed",
        summary: "Signed in. This wallet holds a Binance Agent ID that Termix has not indexed yet.",
        steps: [activateByNameStep(unindexedId), MINT_INSTEAD, BROWSE_STEP],
        warning: walletWarning ?? identityNote,
      };
    }
    if (wallet.mode === "agentic" && externalIds?.available && !externalIds.error && idItems.length === 0) {
      return {
        stage: "agent-id-missing",
        summary: "Signed in with a Binance Agentic Wallet that has no Binance Agent ID yet. Claim one first — it becomes your Termix agent.",
        steps: [{
          do: "Claim a free Binance Agent ID (.ai) in the Binance App, then come back",
          why: "Binance App → Wallet → the Agent ID banner → pick a name (3–15 lowercase letters/digits). It is free, it is your agent's name across the Binance ecosystem, and on Termix it is your agent directly — no mint. Re-run this check once it is claimed.",
          command: "node scripts/aacp-next.mjs",
          doc: "docs/binance-agent-id.md",
        }, MINT_INSTEAD, BROWSE_STEP],
        warning: walletWarning ?? identityNote,
      };
    }
  }

  // Then an agent to act as. Both sides need one: publishing a request, accepting
  // an offer and checkout all carry a `clientAgentId`, and hosting obviously does.
  if (agents && !agents.error && agents.count === 0) {
    return {
      stage: "no-agents",
      summary: withPrefix(linked
        ? "The web account owns no agent yet — every action is taken as one."
        : "Signed in, but this wallet owns no agent yet — every action is taken as one."),
      steps: [{
        do: "Create (mint) your first agent",
        why: linked
          ? "Publishing a request, accepting an offer and selling all act as an owned agent. The mint is signed by your web wallet in the browser."
          : "Publishing a request, accepting an offer and selling all act as an owned agent.",
        command: "node scripts/aacp-api.mjs GET /api/v1/config/contracts --auth none",
        doc: "docs/provider-create-agent.md",
      }, BROWSE_STEP],
      warning: walletWarning ?? identityNote,
    };
  }

  // From here everything is possible, so lead with whatever is already waiting.
  const steps = [];
  if (work?.fundedOrders) {
    steps.push({
      do: work.pendingAccept
        ? `Accept and deliver ${work.fundedOrders} funded order${work.fundedOrders > 1 ? "s" : ""} (${work.pendingAccept} not accepted yet)`
        : `Deliver ${work.fundedOrders} funded order${work.fundedOrders > 1 ? "s" : ""}`,
      why: "A buyer has already paid and a delivery deadline is running. This is the one with money at stake.",
      command: work.pendingAccept
        ? "node scripts/aacp-api.mjs GET '/api/v1/orders?side=provider&status=PENDING_ACCEPT' --auth session"
        : "node scripts/aacp-api.mjs GET '/api/v1/orders?side=provider&status=FUNDED' --auth session",
      doc: "docs/provider-order-delivery.md",
    });
  }
  if (work?.activeOffers) {
    steps.push({
      do: `Review ${work.activeOffers} offer${work.activeOffers > 1 ? "s" : ""} on your requests`,
      why: "Providers have quoted work you published; accepting one is what starts an order.",
      command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders --auth session",
      doc: "docs/client-review-offers.md",
    });
  }
  if (idleIds[0]) steps.push(activateStep(idleIds[0]));
  else if (unindexedId) steps.push(activateByNameStep(unindexedId));
  steps.push({
    do: "Publish a request — pay someone to do work (client side)",
    why: "Describe the job and a budget; providers come to you with quotes.",
    command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders --auth session",
    doc: "docs/client-publish-brief.md",
  });
  steps.push({
    do: "Take work — quote an open request (provider side)",
    why: "Browse what buyers are asking for and send an offer as one of your agents.",
    command: "node scripts/aacp-api.mjs GET /api/v1/prepayment-orders/discover --auth session",
    doc: "docs/provider-offer.md",
  });
  steps.push({
    do: "Go online — host an agent so it answers buyers from this conversation",
    why: "Blocks until a buyer writes, then hands you the message. Costs nothing while waiting, and keeps the agent ONLINE.",
    command: `node scripts/aacp-watch.mjs wait --agent ${agents?.items?.[0]?.agentId ?? "<agentId>"}`,
    doc: "docs/watch.md",
  });
  steps.push({
    do: "Or let the platform answer — cloud hosting, set up on the website",
    why: "No runtime, no key: the platform replies from a knowledge base you review. Switch back to this terminal anytime with `hosting off`.",
    command: `node scripts/a2a-runtime.mjs hosting status --agent ${agents?.items?.[0]?.agentId ?? "<agentId>"}`,
    doc: "docs/a2a-runtime.md",
  });
  steps.push({
    do: "See the whole account",
    why: "Balances, stake, agents, orders and disputes in one read-only pass.",
    command: "node scripts/aacp-api.mjs GET /api/v1/dashboard --auth session",
    doc: "docs/account-overview.md",
  });

  const waiting = (work?.fundedOrders ?? 0) + (work?.activeOffers ?? 0);
  return {
    stage: waiting ? "work-waiting" : "ready",
    summary: withPrefix(waiting
      ? `Ready — and ${waiting} item${waiting > 1 ? "s need" : " needs"} a decision now.`
      : "Ready. Nothing is waiting, so pick a direction."),
    steps,
    warning: walletWarning ?? identityNote,
  };
}

// ── report ──────────────────────────────────────────────────────────────────

async function main() {
  const link = probeLink();
  const wallet = await probeWallet(link);
  const session = await probeSession(link);
  const [agents, work, externalIds] = await Promise.all([probeAgents(session), probeWork(session), probeExternalIds(session, link)]);
  const plan = planFor({ wallet, session, agents, work, externalIds, link });

  console.log(JSON.stringify({
    skillVersion: installedVersion(),
    chain: { chain: activeChainSlug(), network: activeChain().network, chainId: activeChain().chainId, api: resolveApiBaseUrl() },
    identity: link.identity,
    link,
    wallet,
    session,
    agents,
    work,
    ...(externalIds ? { externalIds } : {}),
    hostedAgentTokenCached: Boolean(loadCachedToken()),
    stage: plan.stage,
    summary: plan.summary,
    ...(plan.linkAvailable ? { linkAvailable: true } : {}),
    ...(plan.warning ? { warning: plan.warning } : {}),
    nextSteps: plan.steps.map((s, i) => ({ n: i + 1, ...s })),
    // Addressed to the agent reading this, not to the user: the steps above are
    // a menu to OFFER, not a script to execute. Running one unasked is how a
    // "what can I do?" turns into a signature request nobody agreed to.
    tellUser: "Show these as a short numbered menu in the user's own language, then ask which one they want. Do not run any of them without being asked.",
  }, null, 2));
}

function usage(code = 0) {
  process.stderr.write(`Usage: node scripts/aacp-next.mjs [--offline] [--skip-wallet]

Reports where the user is in the Termix journey (link the web account, or
wallet → login; then agent → publish / take work / host) and the next steps
available from here, each with the exact command and the doc to read.
Read-only: it never signs or writes.

  --skip-wallet   Do not probe the Binance Agentic Wallet CLI.
  --offline       Do not touch the network or the wallet CLI at all.

Env: AACP_CHAIN, AACP_BASE_URL, TERMIX_WALLET_MODE (see docs/env.md).
`);
  process.exit(code);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (args.some((a) => ["help", "--help", "-h"].includes(a))) usage(0);
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { planFor };
