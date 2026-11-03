#!/usr/bin/env node
//
// Termix watcher — block until there is something to do (docs/watch.md).
//
// THE POINT: polling is free, thinking is not. Every source below is a cheap
// REST GET that costs zero tokens, so it can run every few seconds. A model is
// only needed once something has actually changed.
//
// The obvious alternatives both fuse the two and pay for it. A cron job wakes a
// whole fresh agent on a fixed tick, which re-reads the skill and pays a cold
// start whether or not there is work. A background auto-reply worker needs an
// LLM API key most operators do not have. This inverts it: a plain Node process
// does the watching, and the host agent — the conversation the user is already
// in — is woken only when there is real work, with the next command attached.
//
//   node aacp-watch.mjs wait [--agent <id>] [--interval 10] [--timeout 300]
//   node aacp-watch.mjs status
//   node aacp-watch.mjs reset
//
// It runs in the FOREGROUND and never detaches. That is deliberate: agent
// harnesses commonly reap processes spawned by a command once that command
// exits, so `nohup`/`setsid` daemons die silently. A blocking foreground call
// is the one shape that works everywhere — the agent simply waits on the tool
// call, spending nothing while it does.
//
// Auth: the account credential (web-account link, or the wallet session) for
// orders/offers, and a runtime token for chat. No model, no LLM key, ever.
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeChainSlug, chainCacheFile, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, isLinkExpiredError } from "./aacp-credentials.mjs";
import {
  ensureRuntimeToken,
  http,
  loadSessionToken,
  providerOrdersAwaiting,
  resolveAgentId,
  sendSignal,
} from "./a2a-runtime.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function strArg(name, fallback) {
  const v = arg(name);
  return typeof v === "string" && v ? v : fallback;
}
function numArg(name, fallback) {
  const v = Number(strArg(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cursors are per chain. BSC, Base and Robinhood are separate backends with separate
// databases, so a `since` timestamp advanced on one would silently skip buyer
// messages on the other — the ids never collide, but the clock does.
function statePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-watch-state", ".json"));
}
function loadState() {
  try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return {}; }
}
function saveState(state) {
  // Best-effort: a read-only cwd must not stop the watcher from reporting work.
  // The cost is a replayed announcement after a restart, which is noise, not a
  // wrong reply — `reply` itself is what mutates anything.
  try { writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
}

// Wallet-session GET. `orders` and `offers` are account-scoped, not agent-scoped,
// so they ride the session token cached by `a2a-runtime.mjs login`.
async function sessionGet(path) {
  const token = loadSessionToken();
  if (!token) throw new Error("Not logged in. Run `node scripts/aacp-link.mjs start` (web account) or `node scripts/a2a-runtime.mjs login` (wallet) first.");
  return http("GET", path, { token }).catch((err) => {
    // A dead link has a different cure than a lapsed session; name it.
    if (isLinkExpiredError(err) && activeIdentity() === "linked") {
      throw new Error("The web-account link is expired or revoked. Run `node scripts/aacp-link.mjs start` to link again.");
    }
    throw err;
  });
}

// ── which sources to watch ──────────────────────────────────────────────────
//
// Explicit flags win. With none given, watch everything this wallet can
// meaningfully be woken for: buyer messages (needs an agent to be hosted),
// funded orders awaiting delivery, and new quotes on the wallet's own requests.

/**
 * Which sources a run watches. Pure, so the behaviour is explicit and testable.
 *
 * `chat` is dropped when there is no agent to host rather than throwing: an
 * operator watching only their own requests should not have to pass flags to
 * silence a source they never asked for.
 */
export function resolveSourcesFor(agentId, explicit = []) {
  if (explicit.length) return new Set(explicit);
  const auto = new Set(["orders", "offers"]);
  if (agentId) auto.add("chat");
  return auto;
}

function explicitSources() {
  return ["chat", "orders", "offers"].filter((s) => args.includes(`--${s}`));
}

// ── sources ─────────────────────────────────────────────────────────────────
//
// Each returns an array of events. Each event carries a `hint`: the exact next
// command. That is not decoration — it is what stops the woken agent re-reading
// three documents to work out what to do, which is the whole token bill.

// Buyer messages addressed to the hosted agent.
//
// The runtime inbox is agent-scoped and already excludes the agent's own replies,
// BLOCKED text and platform status events (OFFER_EVENT / ORDER_EVENT / SYSTEM),
// so everything it returns is something a human would expect an answer to.
//
// Polling it is ALSO the presence heartbeat — `fetchRuntimeInbox` stamps
// lastSeenAt server-side. A looping `wait` is therefore what keeps the agent
// ONLINE; there is no worker to run.
async function watchChat(agentId, state, session) {
  let res;
  try {
    res = await http("GET", inboxPath(state), { token: session.runtimeToken });
  } catch (err) {
    if (err.status !== 401) throw err;
    // A 12 h runtime token can lapse mid-wait. Re-issue once and retry; a second
    // failure is a real error (wrong wallet, agent transferred) and must surface.
    session.runtimeToken = await ensureRuntimeToken(agentId, { reissue: true });
    res = await http("GET", inboxPath(state), { token: session.runtimeToken });
  }
  const events = [];
  for (const m of res.items ?? []) {
    // Advance the cursor off the message rows only, never off `serverTime`: a row
    // committed a beat after the response was built would be skipped forever.
    if (m.createdAt && (!state.chatSince || m.createdAt > state.chatSince)) state.chatSince = m.createdAt;
    // Tell the buyer we picked it up, so the gap while the host agent drafts does
    // not read as silence. Fire-and-forget by design — see a2a-runtime.mjs.
    if (m.conversationId) void sendSignal(session.runtimeToken, m.conversationId);
    // A buyer who picked the listing's "Custom" package arrives as a structured
    // `listing_quote_request` (businessId = the listing, metadata = their scope +
    // the reference tier they started from). That is a request for a PRICE, not a
    // chat — surface the scope/reference and point straight at the offer flow so
    // the agent quotes proactively instead of looping on questions.
    const meta = m.metadata && typeof m.metadata === "object" ? m.metadata : {};
    const isQuoteRequest = m.businessType === "listing_quote_request";
    const refTier = isQuoteRequest && meta.referenceTier && typeof meta.referenceTier === "object" ? meta.referenceTier : null;
    events.push({
      type: "chat.message",
      conversationId: m.conversationId,
      messageId: m.messageId,
      from: m.from?.handle ?? m.from?.displayName ?? m.from?.accountId ?? null,
      kind: m.kind,
      text: m.text ?? "",
      businessType: m.businessType ?? null,
      listingId: isQuoteRequest ? m.businessId ?? null : null,
      requestedScope: isQuoteRequest && typeof meta.scope === "string" ? meta.scope : null,
      referenceTier: refTier,
      orderId: m.orderId ?? null,
      prepaymentOrderId: m.prepaymentOrderId ?? null,
      attachments: (m.attachments ?? []).length,
      createdAt: m.createdAt ?? null,
      what: isQuoteRequest
        ? "A buyer requested a CUSTOM QUOTE from your listing. They want a price with your reasoning — respond with a priced offer, not just questions."
        : "A buyer sent a message to your hosted agent.",
      hint: isQuoteRequest
        ? `Read their scope${refTier && refTier.price != null ? ` (they started from ${refTier.name ?? "a package"} at $${refTier.price})` : ""}, then SEND A PRICED OFFER with your reasoning and attach the listing: POST /api/v1/conversations/${m.conversationId}/offers with { price, currency, deliveryDays, scope, listingId:"${m.businessId ?? ""}" } — see docs/provider-offer.md. Ask a clarifying question only if a detail actually changes the price, and still propose a starting price.`
        : `node scripts/a2a-runtime.mjs reply --conversation ${m.conversationId} --text "<your reply>"`,
    });
  }
  return events;
}

function inboxPath(state) {
  const params = new URLSearchParams({ limit: "10" });
  if (state.chatSince) params.set("since", state.chatSince);
  return `/api/v1/a2a/runtime/inbox?${params.toString()}`;
}

// How many events one wake-up may carry, per source. The events the budget does
// NOT cover are deliberately left unannounced, so the next `wait` returns them —
// bounded output, nothing dropped. Measured need: a test account's first poll
// produced 82 events / 35 KB, which is a context blow-up, not a to-do list.
const MAX_EVENTS_PER_SOURCE = 20;

/**
 * First contact with a source records what already exists and announces NOTHING.
 *
 * `chat` gets this for free by seeding its cursor at "now". Orders and offers
 * have no clock to seed, so without this the first `wait` dumps every open order
 * and every outstanding quote the account has ever accumulated — work the
 * operator has usually long since handled. Announcing that is how a watcher
 * becomes noise that gets muted. `--replay` opts back in.
 */
function seedOrAnnounce(state, source, ids, makeEvent) {
  const announced = state[source] ?? (state[source] = {});
  const seeded = state.seeded ?? (state.seeded = {});
  const fresh = ids.filter((id) => !announced[id]);
  if (!seeded[source]) {
    seeded[source] = new Date().toISOString();
    if (!args.includes("--replay")) {
      for (const id of fresh) announced[id] = "seeded";
      return [];
    }
  }
  const events = [];
  for (const id of fresh.slice(0, MAX_EVENTS_PER_SOURCE)) {
    announced[id] = new Date().toISOString();
    events.push(makeEvent(id));
  }
  // Never a silent cap: say what is still queued, so a backlog reads as a
  // backlog rather than as "that was everything".
  if (fresh.length > MAX_EVENTS_PER_SOURCE) {
    events[events.length - 1].moreQueued = fresh.length - MAX_EVENTS_PER_SOURCE;
  }
  return events;
}

// Orders the buyer has already paid for. These are the ones with money at stake
// and a delivery deadline running, so they matter more than anything else here.
// An order is announced once: PENDING_ACCEPT → FUNDED keeps the same id.
async function watchOrders(state) {
  const byId = new Map((await providerOrdersAwaiting(sessionGet)).map((o) => [o.id, o]));
  return seedOrAnnounce(state, "orders", [...byId.keys()], (id) => orderFundedEvent(byId.get(id)));
}

export function orderFundedEvent(order, now = Date.now()) {
  const id = order.id;
  const deliveryDueAt = order.deliveryDueAt ?? order.deadlines?.deliveryDueAt ?? null;
  const overdue = Boolean(deliveryDueAt && Date.parse(deliveryDueAt) < now);
  if (order.status !== "PENDING_ACCEPT") {
    return {
      type: "order.funded",
      orderId: id,
      status: order.status,
      deliveryDueAt,
      ...(overdue ? { overdue } : {}),
      what: "A buyer funded an order. It needs delivering.",
      hint: `node scripts/aacp-api.mjs GET /api/v1/orders/${id} --auth session   (then docs/provider-order-delivery.md)`,
    };
  }
  return {
    type: "order.funded",
    orderId: id,
    status: order.status,
    deliveryDueAt,
    ...(overdue ? { overdue } : {}),
    what: overdue
      ? "A buyer funded an order that was never accepted, and its delivery deadline has passed. Ask the user before accepting — the buyer can cancel it for a refund."
      : "A buyer funded an order. Accept it on-chain first, then deliver.",
    hint: `node scripts/aacp-api.mjs POST /api/v1/orders/${id}/provider-accept/prepare --auth session --body '{}'   (then aacp-tx.mjs --intent '<intent>' --yes; docs/provider-order-delivery.md)`,
  };
}

// New quotes on requests THIS wallet published — the client side of the same
// loop. `GET /api/v1/prepayment-orders` returns the wallet's own briefs with
// their offers inlined, so one call covers every open request.
async function watchOffers(state) {
  const res = await sessionGet("/api/v1/prepayment-orders");
  const briefs = Array.isArray(res) ? res : res.items ?? [];
  const byId = new Map();
  for (const brief of briefs) {
    // A brief that already has an accepted offer is done being shopped; further
    // offer rows on it are history, not a decision waiting on the user.
    if (brief.acceptedOfferId) continue;
    for (const offer of brief.offers ?? []) {
      // ACTIVE is the only status that is a live decision. DRAFT was never sent;
      // ACCEPTED / LOCKED are already past the decision; WITHDRAWN / EXPIRED /
      // DECLINED are dead. Waking someone for those is the noise that gets a
      // watcher muted — observed on a real account, where most of the backlog
      // was WITHDRAWN.
      if (offer.status && offer.status !== "ACTIVE") continue;
      byId.set(offer.id, { offer, brief });
    }
  }
  return seedOrAnnounce(state, "offers", [...byId.keys()], (id) => {
    const { offer, brief } = byId.get(id);
    // Price lives on the current REVISION, not the offer: an offer is a
    // container and its number changes as the seller revises.
    const current = offer.current ?? null;
    return {
      type: "offer.received",
      offerId: id,
      briefId: brief.id,
      briefTitle: brief.title ?? null,
      price: current?.price ?? null,
      currency: current?.currency ?? null,
      deliveryDays: current?.deliveryDays ?? null,
      seller: offer.seller?.displayName ?? offer.seller?.handle ?? offer.providerAgentId ?? null,
      status: offer.status ?? null,
      what: "A provider quoted one of your requests.",
      hint: `node scripts/aacp-api.mjs GET /api/v1/prepayment-orders/${brief.id} --auth session   (then docs/client-review-offers.md)`,
    };
  });
}

async function pollOnce(sources, { agentId, state, session }) {
  const events = [];
  const errors = [];
  const run = async (name, fn) => {
    try {
      events.push(...(await fn()));
    } catch (err) {
      // One failing source must not blind the others. A chat inbox that 500s
      // should not stop a funded order from being reported.
      errors.push({ source: name, error: err instanceof Error ? err.message : String(err) });
    }
  };
  if (sources.has("chat") && agentId) await run("chat.message", () => watchChat(agentId, state, session));
  if (sources.has("orders")) await run("order.funded", () => watchOrders(state));
  if (sources.has("offers")) await run("offer.received", () => watchOffers(state));
  return { events, errors };
}

// ── commands ────────────────────────────────────────────────────────────────

async function agentIdForRun() {
  const explicit = strArg("agent") ?? process.env.A2A_AGENT_ID?.trim();
  if (!explicit || explicit === "<agent-id>") return null;
  // Accept a name or agentTokenId the same way `autoreply` does, so the user can
  // paste back whatever `agents` showed them.
  return resolveAgentId(explicit).catch(() => explicit);
}

async function cmdWait() {
  const agentId = await agentIdForRun();
  const sources = resolveSourcesFor(agentId, explicitSources());
  // Floor the interval at 5 s: this is someone else's backend, and nothing here
  // changes fast enough to justify more.
  const interval = Math.max(5, numArg("interval", 10));
  const timeout = Math.max(0, numArg("timeout", 300));

  if (sources.has("chat") && !agentId) {
    throw new Error("--agent <id|tokenId|name> is required to watch chat (or set A2A_AGENT_ID).");
  }

  const state = loadState();
  const sinceOverride = strArg("since");
  if (sinceOverride) state.chatSince = sinceOverride;
  // First run seeds at now: a freshly hosted agent should answer what arrives
  // from here on, not re-litigate a backlog the operator may have handled by
  // hand. `--since <iso>` and `--replay` are the deliberate opt-ins to replay,
  // and `--replay` means the same thing for orders and offers (see
  // seedOrAnnounce) so one flag covers "show me the backlog too".
  else if (!state.chatSince && !args.includes("--replay")) state.chatSince = new Date().toISOString();

  const session = { runtimeToken: null };
  if (sources.has("chat")) session.runtimeToken = await ensureRuntimeToken(agentId);

  const startedAt = Date.now();
  let polls = 0;

  while (true) {
    polls += 1;
    const { events, errors } = await pollOnce(sources, { agentId, state, session });
    // Cloud hosting hand-off notice, once per agent: the poll above is what
    // paused the platform's answering (server-side, on the first heartbeat).
    // Say so, or the owner's notification looks like an unexplained pause.
    if (polls === 1 && sources.has("chat") && session.runtimeToken) {
      const noticed = state.hostingNoticed ?? (state.hostingNoticed = {});
      if (!noticed[agentId]) {
        const hosting = await http("GET", "/api/v1/a2a/runtime/hosted", { token: session.runtimeToken }).catch(() => null);
        if (hosting?.hosted && hosting.disabledByHandoff) {
          noticed[agentId] = new Date().toISOString();
          events.unshift({
            type: "hosting.handoff",
            agentId,
            what: "Cloud hosting was paused because this runtime came online. This terminal answers now.",
            hint: `node scripts/a2a-runtime.mjs hosting on --agent ${agentId}   # hand answering back to the platform`,
          });
        }
      }
    }
    saveState(state);

    // Every source failing on the very first poll is a setup problem — not
    // logged in, wrong chain, backend down — and a caller that treats it as
    // "nothing happened" will wait forever on a watcher that can never see
    // anything. Fail loudly instead. Later polls stay tolerant: a transient
    // outage should not end a hosting session.
    if (polls === 1 && errors.length === sources.size) {
      throw new Error(`every watched source failed: ${errors.map((e) => `${e.source}: ${e.error}`).join(" | ")}`);
    }

    if (events.length) {
      console.log(JSON.stringify({
        timedOut: false,
        waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
        polls,
        watching: [...sources],
        events,
        ...(errors.length ? { errors } : {}),
        next: "Handle these, then call `wait` again. Waiting costs no tokens.",
      }, null, 2));
      return;
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    // `--timeout 0` means "one poll, tell me now" — a cheap status check rather
    // than a wait.
    if (timeout === 0 || elapsed + interval > timeout) {
      console.log(JSON.stringify({
        timedOut: true,
        waitedSeconds: Math.round(elapsed),
        polls,
        watching: [...sources],
        events: [],
        ...(errors.length ? { errors } : {}),
        next: "Nothing happened. Call `wait` again to keep watching.",
      }, null, 2));
      return;
    }
    await sleep(interval * 1000);
  }
}

async function cmdStatus() {
  const agentId = await agentIdForRun();
  const state = loadState();
  console.log(JSON.stringify({
    chain: activeChainSlug(),
    api: resolveApiBaseUrl(),
    agentId,
    identity: activeIdentity(),
    loggedIn: Boolean(loadSessionToken()),
    watching: [...resolveSourcesFor(agentId, explicitSources())],
    chatSince: state.chatSince ?? null,
    known: {
      ordersAnnounced: Object.keys(state.orders ?? {}).length,
      offersAnnounced: Object.keys(state.offers ?? {}).length,
    },
    stateFile: existsSync(statePath()) ? statePath() : `${statePath()} (not created yet)`,
  }, null, 2));
}

async function cmdReset() {
  saveState({});
  console.log(JSON.stringify({
    status: "reset",
    note: "Cursors cleared. The next `wait` treats everything currently open as new, and starts chat from that moment.",
  }, null, 2));
}

function usage(code = 0) {
  process.stderr.write(`Usage: node scripts/aacp-watch.mjs <command> [options]

  wait [--agent <id|tokenId|name>] [--interval 10] [--timeout 300]
       [--chat] [--orders] [--offers] [--since <iso>] [--replay]
        Block until something needs doing, then print it and exit. Polling is
        plain REST and costs NO tokens, so the agent spends nothing while
        waiting. Without source flags it watches chat (when an agent is given),
        funded orders and offers on your own requests. --timeout 0 polls once
        and returns immediately.
        The first run records what already exists and announces nothing, so
        hosting starts from "what happens next" rather than from a pile of
        history. --replay announces that backlog instead; --since <iso> does the
        same for chat from a chosen point.

  status   What it would watch, and what it already knows about.
  reset    Clear cursors; everything currently open counts as new again.

Env:
  A2A_AGENT_ID    Default for --agent.
  AACP_CHAIN, AACP_BASE_URL   Chain / API base (see docs/env.md).
  No LLM key is used by this script.

Before the first wait, either link the web account once (\`node scripts/aacp-link.mjs start\`)
or log in with the skill's wallet (\`node scripts/a2a-runtime.mjs login\`).
`);
  process.exit(code);
}

const COMMANDS = { wait: cmdWait, status: cmdStatus, reset: cmdReset };

// Main guard: importing this file for `resolveSourcesFor` must not run a
// command. Same pattern as a2a-runtime.mjs and aacp-update.mjs.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const run = COMMANDS[command];
  if (!run) {
    if (!["help", "--help", "-h"].includes(command)) process.stderr.write(`Unknown command: ${command}\n`);
    usage(["help", "--help", "-h"].includes(command) ? 0 : 2);
  }
  run().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
