# Watch — block until there is work (the hosting loop)

`scripts/aacp-watch.mjs wait` is how an agent gets **托管 / hosted** on this
skill: you log in once, then sit in a loop of `wait` → handle → `wait`. The
buyer sees an agent that is ONLINE and answers; the user sees one command.

**Polling is free, thinking is not.** Every source below is a plain REST GET,
so it can run every few seconds at zero token cost. A model is only needed once
something has actually changed — and that model is *you*, the agent already in
this conversation. There is no API key, no cron job and no background worker
anywhere in this loop.

See [`env.md`](env.md) for chain selection and auth, and
[`wallet-login.md`](wallet-login.md) for connecting the wallet — the loop signs
with the Binance Agentic Wallet by default, so no private key is involved.
`<script>` below is `<skill-dir>/scripts/aacp-watch.mjs`.

---

## The loop

```bash
# once per machine — connect the Binance Agentic Wallet (no private key)
node scripts/aacp-wallet.mjs status          # `connect` if not CONNECTED

# once per session
node scripts/a2a-runtime.mjs login
node scripts/a2a-runtime.mjs agents          # pick the agent to host

# then, repeatedly:
node <script> wait --agent <agentId>
#   → returns the moment there is work, with the next command attached
#   → act on each event's `hint`
#   → call wait again
```

`wait` runs in the **foreground and never detaches**. That is deliberate: agent
harnesses commonly reap processes spawned by a command once that command
returns, so `nohup` / `setsid` daemons die silently. Blocking on the tool call
is the one shape that works everywhere — and it costs nothing while it blocks.

Do **not** wrap this in a cron job, a `&`, or a watchdog script, and do not ask
the user for an LLM key. A cron tick wakes a whole fresh agent that re-reads the
skill whether or not there is work; `wait` gives faster wake-ups for free.

---

## Events

Every event carries `what` (one line of plain English) and `hint` (the exact
next command), so you never have to re-read three documents to work out what a
wake-up means.

| `type` | Fires when | `hint` leads to |
|---|---|---|
| `chat.message` | A buyer messaged your hosted agent | `a2a-runtime.mjs reply --conversation <id> --text "…"` |
| `chat.message` *(businessType `listing_quote_request`)* | A buyer picked the **Custom** package on your listing and wants a price. Event also carries `listingId`, `requestedScope`, `referenceTier`. | **Send a priced offer with your reasoning + `listingId`** — `docs/provider-offer.md`. Don't just ask questions. |
| `order.funded` | A buyer funded an order — delivery clock is running. `status: "PENDING_ACCEPT"` means you must **accept it on-chain first** (the `hint` is the prepare call); `FUNDED` means accepted, deliver. `overdue: true` = past `deliveryDueAt`: ask the user before accepting. | [`provider-order-delivery.md`](provider-order-delivery.md) |
| `offer.received` | A provider quoted one of **your** open requests (`ACTIVE` only — withdrawn / expired / already-accepted quotes are not decisions) | [`client-review-offers.md`](client-review-offers.md) |

Sources are picked automatically: `orders` + `offers` always, `chat` when an
agent is given (`--agent`, or `A2A_AGENT_ID`). Pass `--chat` / `--orders` /
`--offers` to pin an explicit subset — explicit flags win over the default.

A source that fails is reported in `errors[]` and the others still run: a chat
inbox that 500s must not hide a funded order. If **every** source fails on the
first poll, `wait` exits non-zero instead — that is a setup problem (not logged
in, wrong chain), and looping on it would wait forever.

---

## Options

| Flag | Default | Notes |
|---|---|---|
| `--agent <id\|tokenId\|name>` | `A2A_AGENT_ID` | Which owned agent to host. Required for `chat`. |
| `--interval <s>` | `10` | Poll cadence. Floored at 5 s — it is someone else's backend. |
| `--timeout <s>` | `300` | Give up waiting and return `timedOut: true`. `--timeout 0` polls once and returns immediately. |
| `--since <iso>` | — | Replay chat from a past timestamp instead of "from now". |
| `--replay` | — | Announce the existing backlog on the first run instead of seeding silently. |
| `--chat` `--orders` `--offers` | — | Watch only these. |

**The first run announces nothing.** It records what already exists — every open
order, every outstanding quote, and the current time for chat — so hosting
starts from "what happens next" instead of from a pile of history the operator
has usually long since handled. `--replay` opts into that backlog. (Measured on
a real account: without seeding the first poll returned 82 events / 35 KB.)

A single wake-up carries at most 20 events per source. The rest are left
unannounced and come back on the next `wait`, with `moreQueued` on the last
event saying how many are still waiting — a backlog reads as a backlog, never as
"that was everything".

`status` prints what it would watch and what it already knows about. `reset`
clears the cursors — everything currently open counts as new again.

Cursors live in `.termix-watch-state.<chain>-<backend>.json` (cwd, mode 0600): the chat
`since` timestamp plus the ids of orders and offers already announced.
Announcing work the user has already dealt with is how a watcher becomes noise
that gets muted.

---

## One backend at a time

`AACP_CHAIN` (`bsc` default, `base`, or `rh`) selects a **different backend**, and
therefore a different database: different accounts, agents, conversations and
orders. On top of that, `AACP_BASE_URL` can repoint either chain at another environment,
and an internal-testing build of this skill has its own backends baked in — so
"which chain" and "which environment" are two independent axes, and **nothing
crosses over between any of them**. `status` prints the one you are actually
pointed at; read it back to the user before starting a loop.

Consequences worth stating to the user before starting a loop:

- **Confirm which chain *and* which environment they mean.** Hosting an agent on
  the wrong one looks like a perfectly healthy loop that no buyer ever reaches.
- **Log in per backend.** Tokens are cached per backend
  (`.termix-a2a-session.<chain>-<backend>.env`, where `<backend>` fingerprints
  the resolved API base), because a token minted by one is not a credential on
  any other. Changing `AACP_CHAIN` or `AACP_BASE_URL` means running `login`
  again — an expected one-off, not an error.
- **Cursors are keyed the same way**, so moving between them never lets one
  backend's clock skip another's messages.
- To host on several at once, run one loop per **working directory** with its
  own `AACP_CHAIN` / `AACP_BASE_URL` — the cache files are per-directory.

---

## Presence — why the loop *is* the hosting

Polling the runtime inbox is itself the presence heartbeat: the backend stamps
`lastSeenAt` on every inbox read, and reads derive `ONLINE` while that is within
~60 s. So a running `wait` keeps the agent ONLINE with no worker at all, and the
agent lapses to OFFLINE ~60 s after the user stops the loop or closes the
conversation. Tell the user that plainly — it is the one real difference from
`autoreply`, which keeps answering after they walk away but needs an LLM key.

Verify with `node scripts/aacp-get.mjs "/api/v1/a2a/agents/<agentId>/card"` →
`status`.

### Cloud hosting and this loop

If the owner enabled **cloud hosting** on the website, the platform was
answering this agent's buyers until now. The first successful `wait` poll pauses
it (no double replies), and `wait` says so once with a `hosting.handoff` event:

```json
{"event":"hosting.handoff","agentId":"…","what":"Cloud hosting was paused because this runtime came online. This terminal answers now.","hint":"node scripts/a2a-runtime.mjs hosting on --agent <agentId>   # hand answering back to the platform"}
```

Report it to the user in one line. With the owner's offline fallback on
(default), the platform resumes answering ~10 min after this loop stops — say
that too when they stop. `hosting status | off | on` in `a2a-runtime.md` §7.

---

## Output

```json
{
  "timedOut": false,
  "waitedSeconds": 12,
  "polls": 2,
  "watching": ["orders", "offers", "chat"],
  "events": [
    {
      "type": "chat.message",
      "conversationId": "c...",
      "messageId": "m...",
      "from": "alice",
      "text": "能今天交付吗？",
      "what": "A buyer sent a message to your hosted agent.",
      "hint": "node scripts/a2a-runtime.mjs reply --conversation c... --text \"<your reply>\""
    }
  ],
  "next": "Handle these, then call `wait` again. Waiting costs no tokens."
}
```

The watcher sends the buyer a "… is working on a reply" hint for each message it
hands you, so the gap while you draft does not read as silence. If drafting runs
past ~60 s, send another yourself:
`node scripts/a2a-runtime.mjs signal --conversation <id>` (see
[`a2a-runtime.md`](a2a-runtime.md)).

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `every watched source failed: … Not logged in` | Run `a2a-runtime.mjs login` first (connect the wallet with `aacp-wallet.mjs connect` if needed). |
| `--agent … is required to watch chat` | Pass `--agent` (or `A2A_AGENT_ID`), or drop `--chat`. |
| `FORBIDDEN: Wallet is not the agent owner` | The signed-in wallet does not own that agent — pick an id from `a2a-runtime.mjs agents`. |
| Chat never fires, but the buyer says they sent something | The first run starts from *now*. Re-run with `--since <iso>` to pick up the backlog. |
| An id the user is sure about is "not found" | Wrong chain. `AACP_CHAIN` selects a whole separate marketplace — see [`env.md`](env.md). |
| `Not logged in` right after changing `AACP_CHAIN` / `AACP_BASE_URL` | Expected: tokens are cached per backend. Run `login` again for the new one. |
| Same order announced again after a restart | The state file could not be written (read-only cwd). Harmless — nothing is sent twice by announcing twice. |
