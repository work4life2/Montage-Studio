# A2A Runtime — bring an owned Agent ONLINE

Host one of a wallet's owned Agents so it answers buyer messages. The operator
pastes their private key in chat once; the connector logs in, lists their
agents, and (after they pick one) issues a runtime token scoped to that agent.

There are **two ways to drive the replies**, and the first is the default:

| | Who drafts | Needs an LLM key | Survives closing the chat |
|---|---|---|---|
| **`aacp-watch.mjs wait`** ([`watch.md`](watch.md)) | **you**, the host agent | no | no — presence lapses ~60 s after the loop stops |
| `autoreply` (below) | a detached worker's own LLM | **yes** | yes |

Start with the wait loop. Only reach for `autoreply` when the user explicitly
wants the agent answering after they walk away, and never ask for an API key
they have not raised themselves.

> dev-v2 has **no WebSocket relay**. The runtime contract is HTTP only:
> wallet-login → list agents → runtime token → inbox poll → reply. "Online" is
> derived server-side from recent inbox polls (no socket); see "Presence" below.

See [`env.md`](env.md) for base URL + auth conventions. `<script>` below is
`<skill-dir>/scripts/a2a-runtime.mjs`, where `<skill-dir>` is the directory
containing this skill's `SKILL.md`.

---

## Flow

```text
private key ─▶ login (nonce→sign→session) ─▶ agents (list owned agents)
                                                      │  operator picks one
                        ┌─────────────────────────────┴─────────────────────────┐
                        ▼                                                       ▼
    aacp-watch.mjs wait --agent <id>   (foreground, no LLM key)   autoreply --agent <id>  (background)
      ├─ ensureRuntimeToken (wallet-signed, 12h; API key when linked) ├─ ensureRuntimeToken
      └─ block on inbox(since) → signal → return the message        └─ loop: inbox(since) → signal
         …the HOST agent drafts and calls `reply`, then waits again        → LLM draft → reply
```

The runtime token is scoped to a single `agentId`; it cannot be reused across
agents. One `autoreply` process = one online agent.

---

## Hard rules

- Never echo `WALLET_KEY`, the session token, or the runtime token back to the
  user. Refer to a wallet only by its address.
- **Identity order is linked › agentic › key.** Linked, nothing here signs at
  all (the web account's key authenticates, the browser wallet signs). Otherwise
  signing defaults to the Binance Agentic Wallet (`TERMIX_WALLET_MODE=agentic`,
  a standalone account) — no private key is handled, every signature is
  EIP-712 typed data the user approves. Only if the user wants neither, set
  `TERMIX_WALLET_MODE=key` with `WALLET_KEY` exported in their own shell. See
  [`wallet-login.md`](wallet-login.md).
- Nothing is persisted except the short-lived cached tokens
  (`.termix-a2a-session.<chain>-<backend>.env`, `.termix-a2a-runtime.<chain>-<backend>.env`,
  mode 0600 — one pair per backend, because a BSC token is not a credential on
  Base, and a dev token is not one on prod).
- Poll cadence default 5 s; do not go below 2 s.
- The inbox already excludes the agent's own messages and `BLOCKED` messages, so
  `autoreply` will not reply to itself or to quarantined text.

---

## Commands

### 1. Log in
```bash
node <script> login
```
`POST /auth/nonce` → sign it → `POST /auth/wallet`. In agentic mode the wallet
signs the response's `typedData` (EIP-712) and the request carries
`signatureType:"eip712"`; in key mode it signs `message` (EIP-191) as before. A
backend that returns no `typedData` has not shipped EIP-712 login yet — the
script says so and the only options are key mode or another chain.
Caches the session token to `.termix-a2a-session.<chain>-<backend>.env` — one per
backend, so switching `AACP_CHAIN` (or pointing `AACP_BASE_URL` at dev instead of
prod) means logging in again. Prints wallet + handle.

### 2. List the wallet's owned Agents
```bash
node <script> agents
```
`GET /api/v1/agents` with the cached session. Returns
`{ count, items:[{ agentId, agentTokenId, name, a2aStatus }] }`. Show the user a
numbered list and ask which to bring online.

> **Linked identity** ([`link.md`](link.md)): steps 1–2 and the runtime token
> all ride the web-account API key. `login` short-circuits, and the token is
> issued from `Authorization: Bearer <key>` with no wallet signature — the key
> was granted by the account that owns the agent, which is the same proof.

### 3. Go online — host-driven (default, no LLM key)

```bash
node scripts/aacp-watch.mjs wait --agent <agentId>
```

Blocks until a buyer message (or a funded order, or a new offer) appears, prints
it with the exact next command, and exits. You draft the reply and post it with
`reply` below, then call `wait` again. The watcher issues the runtime token for
you and sends the buyer a "working on a reply" hint for each message it hands
over. Full contract in [`watch.md`](watch.md).

### 4. Go online — unattended auto-reply (needs an LLM key)
Run as a **plain foreground command** — no `nohup`, no `&`:
```bash
node <script> autoreply --agent <agentId> --interval 5
```
This is the *launcher*: it validates ownership + LLM config, self-detaches a
single background worker, writes `/tmp/termix-autoreply-<agentId>.pid`, and
returns `{"status":"online", pid, log}` immediately. Running it again while the
worker is alive returns `{"status":"already-online", pid}` — it is **idempotent
and singleton**, so repeated calls never spawn duplicates (this is why no
`nohup &` is needed and no elevated/background-exec permission is required
from the host agent).

The worker issues a runtime token (`POST /api/v1/a2a/runtime/token/:agentId`,
wallet-signed) then loops: `GET .../runtime/inbox?since=` → draft a reply via the
LLM → `POST .../runtime/reply`. It only replies to messages that arrive **after**
it starts. On a 401 it re-issues the token once. Each reply is logged to the log
file as `{"event":"auto.reply", inbound, conversation, replyId, text}`.

Options: `--interval <s>`, `--persona "<reply voice instructions>"`,
`--since <iso>` (replay older messages).

### 5. Activity hint — "working on a reply"

```bash
node <script> signal --conversation <conversationId> [--state thinking|typing]
```

`POST /api/v1/a2a/runtime/signal`. Makes the buyer's inbox show
`… is working on a reply` while you draft, so the gap between their message and
yours doesn't look like silence.

**`autoreply` and `loop` already send this for you** — `autoreply` covers the whole
LLM-draft-plus-post window (re-sending every 30 s so a slow model doesn't let it
lapse), and `loop` sends one shot per inbound message. You only call `signal`
directly when driving `inbox` + `reply` yourself, or when a host-drafted reply in
`loop` will take longer than ~60 s.

Properties worth knowing, because they shape how you use it:

- **Nothing is stored.** The server publishes once to the conversation channel and
  keeps no record — this is not a message and never appears in the thread.
- **There is no "stop".** `thinking` expires after ~60 s (`typing` after ~8 s), and
  the buyer's inbox clears it the moment your actual reply lands. Going quiet is how
  it ends, which is also what makes a crashed agent behave correctly.
- **Re-send to hold it.** For work longer than ~60 s, call it again every ~30 s.
- **Failures are silent and safe to ignore.** The command reports `sent` even if the
  publish was dropped. Never retry it and never let it gate your reply — a missing
  hint costs nothing, a stalled reply costs the order.
- Repeats faster than 3 s per conversation are collapsed server-side.

### 6. Stop / go offline
```bash
node <script> autoreply --agent <agentId> --stop
```
Kills the worker and clears the pidfile; presence flips to OFFLINE ~60 s later.
The host-driven loop has no stop command — stopping the `wait` loop *is* how it
ends, and presence lapses the same ~60 s later.

### 7. Cloud hosting ↔ this runtime
The website can host an agent for the owner (**cloud hosting**, 云托管): the
platform answers buyers in-process from a knowledge base the owner reviewed.
It is enabled on the website only (Dashboard › My agents › Enable cloud
hosting); the skill never turns it on. What the skill does control is **who
answers right now**:

```bash
node <script> hosting status --agent <agentId>   # { hosted, enabled, runMode, knowledgeVersion }
node <script> hosting off    --agent <agentId>   # "I'm self-hosting" → platform pauses, owner notified
node <script> hosting on     --agent <agentId>   # hand answering back to the platform
```

- `runMode`: `HOSTED` platform answering · `PAUSED` nobody automatic (manual
  pause or after `off`) · `EXTERNAL` this/another runtime polled recently.
- `status` is read-only: it uses the linked account / wallet session to read the
  owner config, or an existing runtime token. It never issues a runtime token
  because issuance itself triggers takeover. With neither credential, link or
  log in first. Only the status fields are printed, never the knowledge pack.
- The **first inbox poll** by any runtime (token issue or `wait`) pauses cloud
  hosting on its own — `off` only makes the hand-off explicit and immediate,
  before any poll. Both set the same `disabledByHandoff` marker.
- With the owner's **offline fallback** on (default), the platform resumes
  answering ~10 min after the last poll. Say so when the user stops the loop.
- `hosted:false` from `status` means cloud hosting was never enabled for this
  agent; `off` / `on` then answer 404 — nothing to hand over.
- `GET /api/v1/a2a/runtime/context-pack` (runtime token) returns the platform's
  system prompt, knowledge pack, behavior, profile and escalation settings so a
  self-hosted runtime can answer with the same context. `autoreply` uses it as
  the default persona when cloud hosting is configured.

Endpoints (runtime token): `GET /api/v1/a2a/runtime/hosted`,
`POST /api/v1/a2a/runtime/hosted/release`, `POST /api/v1/a2a/runtime/hosted/resume`.

**How the platform did while it was answering** — owner reads, `--auth session`
(the link or the wallet session; not the runtime token). Use these when the
user asks "what did it answer / where did it get stuck" after a cloud-hosted
stretch, and before taking over:

```bash
node scripts/aacp-api.mjs GET /api/v1/agents/<agentId>/hosted-config --auth session          # enabled, runMode, knowledge version
node scripts/aacp-api.mjs GET /api/v1/agents/<agentId>/hosted-stats --auth session           # conversations answered, escalations…
node scripts/aacp-api.mjs GET "/api/v1/agents/<agentId>/hosted-conversations?limit=20" --auth session
node scripts/aacp-api.mjs GET "/api/v1/agents/<agentId>/knowledge-gaps?status=OPEN" --auth session
```

A **knowledge gap** is a buyer question the platform could not answer from the
knowledge base. The one hosting write this skill makes is closing one — the
owner answers here and it becomes an FAQ entry:

```bash
node scripts/aacp-api.mjs POST /api/v1/agents/<agentId>/knowledge-gaps/<gapId>/resolve --auth session --body '{
  "answer": "<the owner's answer, ≤4000 chars>",
  "addToKnowledge": true
}'
```

`addToKnowledge:false` only closes the gap (the owner replied to the buyer
directly). Only post an answer the user gave; never fill a gap from guesswork.
Enabling, editing or deleting cloud hosting, re-syncing the knowledge base and
the source-to-agent wizard stay on the website (`/hosting?agentId=`).

---

## LLM configuration (used by `autoreply`)

| Env | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` or `OPENAI_API_KEY` | — | Required. OpenAI-compatible chat key. |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` | Chat-completions base. |
| `A2A_LLM_MODEL` | `openai/gpt-4o-mini` | Model id for replies. |

Replies are generated with `POST {base}/chat/completions` (system = persona,
user = inbound text, temperature 0.4, max_tokens 400).

---

## Inbox item fields (for custom handling / `inbox`/`loop`)

| Field | Meaning |
|---|---|
| `messageId` | Server message id (used as `auto-<id>` idempotency key). |
| `conversationId` | Target for `reply`. |
| `conversationKind` | `DIRECT_MESSAGE` / `ORDER_DELIVERY` / `QUOTE_NEGOTIATION` / `PREPAYMENT_ORDER` / `CHALLENGE` / `OPERATOR_CASE`. |
| `orderId` / `prepaymentOrderId` / `disputeId` | Set when tied to a business object; fetch richer context if needed. |
| `kind` / `text` | Message kind + body. |
| `from` | `{ accountId, walletAddress, displayName, handle }`. |
| `createdAt` | ISO timestamp; the worker advances `since` past the max. |

`token` / `inbox` / `reply` / `signal` / `loop` remain available for manual,
per-message control (the host LLM drafts each reply itself instead of the
connector's LLM). When drafting manually, send `signal` after reading a message so
the buyer isn't left staring at silence.

---

## Presence

Every runtime check-in (token issue, inbox poll, reply) stamps the agent
`a2aStatus=ONLINE` + `lastSeenAt`. Reads derive ONLINE while `lastSeenAt` is
within ~60 s, else OFFLINE — so a running `autoreply` **or a looping
`aacp-watch.mjs wait`** keeps the agent ONLINE, and stopping either lets it
lapse to OFFLINE. Verify via
`node scripts/aacp-get.mjs "/api/v1/a2a/agents/<agentId>/card"` → `status`.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `The Binance Agentic Wallet is not signed in` | `node scripts/aacp-wallet.mjs connect` — see [`wallet-login.md`](wallet-login.md). |
| `Developer Mode is off` | Enable it in the Binance App; it cannot be enabled from the CLI. |
| `does not offer EIP-712 wallet login yet` / 401 on `token` in agentic mode | That backend predates the typed-data change. Use `TERMIX_WALLET_MODE=key` there. |
| `WALLET_KEY must be a 32-byte hex private key` | Key mode only. Pass 64 hex chars (`0x` prefix optional). |
| `UNAUTHORIZED` from `login` | Nonce expired (10 min) or wrong signature — re-run `login`. |
| `agents` → `Not logged in` | Run `login` first (or the session token expired). |
| `agents` → `count: 0` | This wallet owns no agents. Mint one before starting A2A. |
| `FORBIDDEN: Wallet is not the agent owner` (autoreply) | The signed-in wallet does not own `--agent`; pick an id from `agents`. |
| `No LLM key` | Set `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`). |
| inbox stays empty | No new buyer messages since the worker started; only conversations where the agent is a member surface here. |
