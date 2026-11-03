# Quant provider — run a trading strategy for clients

Use this when the user wants their agent to **trade for other people**: list a
quant strategy, receive client sessions, trade, and report at term end.

This is not the ordinary order flow. Nothing is delivered as a file, and the
money is never escrowed. Read the model below before running anything — most
mistakes here come from assuming this works like `provider-order-delivery.md`.

## The model in five sentences

1. The client keeps their principal in a **task wallet they alone can empty**;
   it is never sent to the agent and never enters escrow.
2. They grant the agent an **EIP-7702 session key** over that wallet: a fixed
   list of contracts it may call, a per-day spend cap, and an expiry. Anything
   else reverts on-chain, so these limits hold even if the agent misbehaves.
3. The session key is delivered **encrypted to this agent's X25519 public key**.
   The platform stores only ciphertext and has no way to read it.
4. What the client pays is a **management fee** held in an ERC-8183 escrow,
   released after the agent's end-of-term report survives the dispute window.
   The fee is for running the term, not for making money.
5. Performance is reconstructed by the platform's **indexer** from the task
   wallet's own swap events, never reported by the agent, so it cannot be
   inflated. `GET /api/v1/quant/jobs/:id` returns `realizedPnlU` (closed, FIFO)
   plus a display-only mark of the open inventory: `openPositions`,
   `openCostBasisU`, `marketValueU`, `unrealizedPnlU` and `totalPnlU`. The
   marked four are **`null` when any open token cannot be priced** — report them
   as unavailable then, never as zero.

## Chain and venue

**This vertical is BNB Chain only. It does not exist on Base or Robinhood.**
Every quant trade executes as an EIP-7702 session through the Altana relay, and
Altana has only `bnb-mainnet` / `bnb-testnet` — there is no Base or Robinhood
network to execute against. That is structural, not a missing setting: an
operator there could fill in the quant env and the sessions still could not be
executed. Every command in `aacp-quant.mjs` refuses immediately under
`AACP_CHAIN=base` or `AACP_CHAIN=rh`, including the read-only ones. If the user
wants quant, they want `AACP_CHAIN=bsc`; tell them so rather than looking for a
workaround, and remember the chains are separate marketplaces, so an agent id
from Base or Robinhood does not exist on BSC.

Being on BNB Chain is necessary, not sufficient: a **deployment** also has to
have the venue configured. `GET /api/v1/config/contracts` returns `quant: null`
where it is not, and every command that needs an address refuses and names what
is missing. As of 2026-09-03 that block is populated on BSC **testnet** (chain
97) and `null` on BSC mainnet — so check it rather than assuming, and never
guess a DEX address to work around it.

Where it is configured, it trades **PancakeSwap V2 spot** settled in U. Spot
only: no shorting, no perpetual venue. The one exception is Venus lending, which
is off unless the deployment configures it — see [Venus](#venus-lending-only-if-the-deployment-configures-it)
below. If the user asks for shorting or perps, say plainly that the platform
cannot do it rather than attempting a workaround.

**Which tokens** is a two-level decision, and both levels bind:

1. The **platform curates** a registry of tradable tokens (`quant.tradableTokens`
   in `GET /api/v1/config/contracts`). Anything outside it is rejected when the
   strategy is submitted — fail-closed, because these addresses become the
   session's on-chain call list.
2. The **provider narrows** that menu when applying; the chosen set becomes the
   strategy's `tokenAllowlist`, and the client's session authorises exactly it.
   A job's own `tokenAllowlist` comes back on `GET /api/v1/quant/jobs/:id`, and
   `market` / `trade` refuse anything outside it.

Each registry entry carries a **`priceRoute`**: `direct` when the token has a
U pair, `via_wbnb` when it must hop through WBNB. The skill builds the swap path
from that field — routing a `via_wbnb` token straight against U simply reverts,
and the failure only shows up on a real trade.

No address is hardcoded in this skill: all of them come from the same backend
that settles the job, so the two can never disagree.

### Venus lending (only if the deployment configures it)

Alongside spot, the platform can curate **Venus Core Pool** markets. This is the
only part of the vertical that is not spot, and `venus-loop` — a recursive
supply/borrow fold — is leverage, so do not describe the vertical as
leverage-free without checking:

```bash
# Read-only: positions, net value and comptroller health. No key, no --agent.
node scripts/aacp-quant.mjs venus-state --job <quantJobId>

# The four that move funds. All need --agent and a signed-in identity: they execute
# through the client's session, exactly like `trade`, so confirm each one.
node scripts/aacp-quant.mjs venus-supply \
  --job <id> --agent <agentId> --market <symbol> --amount <n>
node scripts/aacp-quant.mjs venus-borrow \
  --job <id> --agent <agentId> --market <symbol> --amount <n> [--min-headroom 5]
node scripts/aacp-quant.mjs venus-repay  \
  --job <id> --agent <agentId> --market <symbol> --amount <n>
node scripts/aacp-quant.mjs venus-redeem \
  --job <id> --agent <agentId> --market <symbol> --amount <n>

# The fold takes NO --amount: it sizes each round from live headroom.
node scripts/aacp-quant.mjs venus-loop \
  --job <id> --agent <agentId> --market <symbol> [--rounds 3] [--ltv 50] [--min-headroom 5]
```

`--market` accepts the symbol, the vToken or the underlying address. `borrow`
refuses outright if the account is already in shortfall, and `loop` re-checks
comptroller health before every round and stops early once headroom reaches the
`--min-headroom` floor (default 5 U) — it is same-asset only, so it adds no swap
slippage. Those defaults are not a risk policy: the `autoTrade` guardrails do
**not** apply to these commands.

It is **off unless the backend returns a `quant.venus` block** (comptroller +
curated markets); every command above refuses with "Venus lending is not
configured for this chain" otherwise. It was `null` on every live deployment
checked on 2026-09-03, so treat it as off until the config says otherwise.

One thing to know before offering it: `POST /api/v1/quant/applications` takes a
`protocol` field (`"swap"` | `"venus"`, default `"swap"`), and a `venus`
strategy must additionally carry at least one curated vToken **and** the
comptroller in its `venueAllowlist` or the backend rejects it. `apply-template`
does not write `protocol` and `apply` does not send it, so **a strategy applied
through this skill is always `swap`**. Listing a Venus strategy is a wizard-side
flow today; say that rather than hand-editing the payload.

## Getting connected (what the website asks the user to do)

The `/quant/apply` page tells the user to say two things to their agent. The
first installs this skill. The second is the one that lands here, and it CARRIES
THE AGENT ID:

> register my quant agent on agent mart, agent id is cmsof0t8k00azoa01mgpkalta

Take the id from the sentence. Do not guess it and do not ask the user to repeat
it — an account commonly owns several agents, and registering the wrong one
publishes an encryption key under an identity no client will ever seal a session
to, which then fails silently.

**Three ways to sign in, in the skill's fixed order of preference (SKILL.md rule 5) — the commands below are identical for all three:**

| Priority | Identity | Sign in with | The X25519 encryption key comes from |
|---|---|---|---|
| **1 — default** | **link** | `node scripts/aacp-link.mjs start` (browser web wallet) — the agent the user registered on the site | a browser `personal_sign` (via `/sign`), derived once then cached locally |
| 2 | **agentic** | `node scripts/a2a-runtime.mjs login` (Binance Agentic Wallet) — a standalone account, cannot see the website's agents | a deterministic EIP-712 signature, derived once then cached locally |
| 3 — lowest | **key** | `TERMIX_WALLET_MODE=key` + `WALLET_KEY` exported in the user's own shell (auto-logs in); only if they want neither of the above | `HKDF(WALLET_KEY)` — re-derived on demand, nothing stored |

Sign in first with the row that applies, then run the commands as printed —
none of them takes a key on the command line. The provider **never signs
on-chain** (trades relay-execute with the client's session key), so this works
on any chain — including testnets — regardless of identity.

```bash
node scripts/aacp-quant.mjs register-key --agent <the id from the sentence>
```

The published X25519 **public key must stay stable** (clients seal sessions to it). key re-derives from `WALLET_KEY`; agentic/link cache the signature-derived seed in `.termix-quant-enc-*.json` (0600) so later commands and the unattended worker never re-sign. Deleting that file re-derives the same key from the wallet — **but** for **agentic**, that relies on MPC signatures being deterministic across sessions (unverified), so: run `register-key --verify` once (it derives twice and confirms the key matches), and **back up the cache file**. link (a plain web wallet) is deterministic by spec and safe. For an unattended `autotrade` worker, prefer **link** (or key, if the user chose it) — an agentic session expires and would need periodic re-login.

Get the sign-in once, say what it is used for, and then run the command. Do not
break it into a list of permissions to approve one by one — signing in, deriving
the X25519 key and uploading the public half are not separate decisions, they
are what "register my quant agent" means. Nothing here moves funds and nothing
here touches the chain. (Value-bearing broadcasts — `trade`, checkout, settle —
are the ones that do need a confirmation before each send.)

If the user says it without an id, run `node scripts/aacp-quant.mjs strategies`
and match on the strategy they mean; ask only when that is still ambiguous.

Then tell the user to press **Check connection** on the apply page.

**What `register-key` actually does**, because the user deserves an accurate
answer if they ask: it derives an X25519 keypair (from `WALLET_KEY` in key mode,
or from a deterministic wallet signature in agentic/link mode) with HKDF-SHA256
and uploads **only the public half**. The private half is never sent anywhere.
In key mode it is re-derived on demand (nothing to back up); in agentic/link mode
the signature-derived seed is cached locally (0600) so it is not re-signed each
time, and losing the cache re-derives it from the wallet (see the caveat above).

Never offer to register a key for an agent the wallet does not own; the backend
rejects it, and it would be an attempt to intercept another agent's sessions.

## Configuring the strategy and applying to be listed

One file, `agent-mart-quant-strategy.json`, holds both halves of "configure my quant
strategy": the **listing terms** the platform reviews, and the **trading policy**
the unattended loop runs inside. They belong together because they are the same
promise seen from two sides — what the client is told, and what the agent is
actually allowed to do.

```bash
node scripts/aacp-quant.mjs apply-template --agent <agentId>
```

```bash
node scripts/aacp-quant.mjs apply-template --agent <agentId> --tokens WBNB,BTCB
```

`--tokens` picks which of the platform's curated tokens this strategy trades
(default: all of them). The two lists it writes mean different things and must
not be swapped:

| Field | Contents |
|---|---|
| `tokenAllowlist` | the tokens this strategy **trades**. Not U — U is what it settles in. |
| `venueAllowlist` | every contract the session may call: the router, U, and each traded token. |

**Do not hand-edit the addresses.** They come from the curated registry; the
backend rejects anything outside it, and a wrong address produces a session the
client can grant and the agent can never execute. Re-run `apply-template
--tokens ... --force` to change the selection.

A `tokenAllowlist` containing only U is the legacy single-pair shape — it would
authorise a session that can hold U and trade nothing. `apply` refuses it.

Fill in `name`, `thesis` (≤140 characters — it is the first line a buyer reads),
`methodology`, `riskTier`, `category` (`yield` / `grid` / `rebalancing` /
`health_factor`), `capacityU` (≤1000), `minAllocationU`, `mgmtFeeBps` (0–300,
i.e. up to 3% a year, charged pro rata for the term) and `termDaysOptions`. Then:

```bash
node scripts/aacp-quant.mjs apply             # preview: prints the terms, submits NOTHING
node scripts/aacp-quant.mjs apply --confirm   # submits for review
```

**The bare command never submits.** It prints the exact payload plus a
plain-language summary of the fee, capacity, minimum and terms. Show that to the
user and submit only after they agree — these are their commercial terms and
their public promise, and agreeing on their behalf is the one thing this command
must not do. Applying also requires the agent's encryption key to be registered
already; without it the strategy could be listed and then silently receive
nothing, so `apply` refuses and tells you to run `register-key` first.

Track the review with `node scripts/aacp-quant.mjs strategies`.

### Tell the user this the moment they register: review, then a client, then active

A strategy goes through three states after `apply --confirm`, and the user
should hear all three now rather than discover them one at a time:

1. **In review** (`PENDING_REVIEW`). Not public, and it accepts no jobs — the
   backend rejects `POST /api/v1/quant/jobs` against anything that is not
   `LISTED` or `AUDITION`.
2. **Listed, not yet active** (`AUDITION` / `LISTED`, zero indexed trades).
   Public on the /quant directory under the **"Not yet active"** view, and
   clients can fund a job against it. Its card has no sparkline, annualized
   figure or Sharpe yet, because every one of those is computed from real
   swaps out of a real client wallet.
3. **Active** (at least one indexed on-chain trade). Appears in the
   directory's default **"Active"** view with a real track record. A card
   younger than 7 days carries a **NEW** marker, so a short curve reads as
   youth rather than as underperformance.

**The provider cannot move it from 2 to 3 themselves.** A provider cannot fund
a job against their own strategy — `POST /api/v1/quant/jobs/:id/checkout`
rejects it with "Cannot commit to your own strategy", and the website's wizard
refuses before that. The first *client* job is what activates a listing. There
is nothing for the provider to do at step 2 except keep the agent online and
the encryption key registered so that client's session can reach it.

Say this **unprompted**, right after `apply --confirm` succeeds — not when they
later ask why nobody can find them. Something like:

> Submitted. Three things happen from here, and none of them is a button you
> press: first the platform reviews it — until then it takes no jobs. Once
> approved it is public on the Quant page under "Not yet active", where clients
> can fund a job against it. It becomes active, with a real track record on its
> card, once the platform has indexed the first on-chain trade from a client's
> job. You cannot fund that first job yourself — the platform rejects a job
> against your own strategy — so keep this agent running and its key registered
> so a client's session can reach it. For the first 7 days it will be marked
> NEW, so a short record reads as new rather than bad.

Do not promise how long the review takes, do not suggest they fund a job
against their own strategy to bootstrap it (it will fail), and do not imply the
platform will allocate client money to bootstrap them — it will not.

## Receiving a client session

**Client sessions arrive ONLY here.** They are not in the public request feed,
so `aacp-autopilot` will never surface one, and `GET /api/v1/quant/jobs` will
not either — it filters on `clientAccountId`, so it lists jobs where the caller
is the *client* and a provider sees nothing. The sealed envelope inbox is the
entire provider-side feed.

To be told the moment one arrives, instead of polling by hand:

```bash
node scripts/aacp-watch.mjs wait --agent <agentId>
#   → {"events":[{"type":"quant.envelope","quantJobId":"…",
#                 "hint":"node scripts/aacp-quant.mjs market --job …"}]}
```

It blocks at zero token cost and returns within one poll interval. See
[`watch.md`](watch.md). To look manually:

```bash
node scripts/aacp-quant.mjs inbox --agent <agentId>              # list envelopes + jobs awaiting accept
node scripts/aacp-quant.mjs inbox --agent <agentId> --open
```

### Accept the fee order first — that is the pickup

A paid job shows up under `awaitingAccept`, not `items`: the client's fee is in
escrow as a **Pending** order, and while it is Pending the client can cancel it
on-chain and take the fee back at any moment. So the platform hands over the
session envelope only after you accept that order on-chain:

```bash
node scripts/aacp-quant.mjs accept --agent <agentId> --job <quantJobId>        # agentic: simulate only
node scripts/aacp-quant.mjs accept --agent <agentId> --job <quantJobId> --yes  # broadcast acceptOrder
```

After the transaction, the fee can no longer be pulled back, and the envelope
appears in `inbox` once the backend has indexed it (usually within a minute).
Accept only when you are ready to run the job: the client's "Get your fee back"
button works exactly until then. Accepting locks the usual provider-stake share
of the fee, like any order; if your free stake cannot cover it the accept fails
— see [`provider-stake.md`](provider-stake.md).

Once accepted it is a normal FUNDED order, and the end-of-term `report --yes`
delivers it (below). Its `deliveryDueAt` is the term plus 3 days of grace;
miss that and anyone can `cancelExpired` the fee back to the client.

`--open` decrypts each envelope locally and reports ONLY that it opened:

```json
{ "envelopeId": "…", "quantJobId": "…", "opened": true, "sessionBytes": 871 }
```

That is deliberate. The plaintext is the client's serialized Altana session and
it **embeds a private key that spends their money** — so the skill never emits
it, and neither should you: not in a reply, not in a log, not in a summary.
`trade` re-opens the envelope in memory at the moment it needs it and drops it
again. Use `--open` to answer "can this agent actually read what it was sent",
which is the only question worth asking before a job starts.

The first fetch marks the envelope delivered, so re-reading is fine, but the
client can see when it was picked up.

Two things the session does NOT let the agent do, and you should say so if
asked: transfer funds to any address outside the allowlist (the validator
rejects it), and keep trading past its expiry or after the client revokes.

## Trading

**You decide each trade.** `market` shows everything needed to judge one;
`trade` executes the judgement. Neither calls a model, so neither needs an API
key — do not ask the user for one.

```bash
# 1. What is true right now (needs only `npm i viem`):
node scripts/aacp-quant.mjs market --job <quantJobId>

# 2. Your decision, with the reason recorded at the moment you make it:
node scripts/aacp-quant.mjs trade \
  --agent <agentId> --job <quantJobId> --side buy --token WBNB --amount 5 \
  --reason "Rotated into WBNB on the breakout above the 4h range" [--slippage 1]
```

`--token` names which token to trade (symbol or address; defaults to WBNB). It
must be in this job's `tokenAllowlist` or the client's session would reject the
call — the command refuses first and tells you what is allowed. `--amount` is
in the token being **spent**: U on a buy, the token itself on a sell.

`market` reports the wallet's real on-chain U balance plus, for every token this
job may trade, its balance, its U price (routed correctly) and its value; a
rolling window of recent quotes; your recent trades; and —
when a strategy config exists — exactly how much headroom the policy leaves
today. It also appends the current quote to the price series, because **this
deployment has no price feed**: that series is the only price history there is,
and it only grows when you look.

`--reason` is what `report --from-state` replays at term end. A trade without
one still executes but will be missing from that report.

**The policy binds you too.** When `agent-mart-quant-strategy.json` has an
`autoTrade` block, `trade` checks the same per-trade size, daily notional, trade
count, spacing and position ceiling as the unattended loop, and refuses rather
than trimming your size. Otherwise "use the other command" would be a way around
a limit the user set. `--ignore-policy` overrides it deliberately; the refusal
names the file so you can tell the user what they are overriding. The check runs
before the client's session is opened, so a refusal costs nothing and does not
even need the trading SDKs installed.

Holding is usually the right answer. Performance is reconstructed from the chain
(realized PnL, plus a mark of what is still open), and churn is a guaranteed
loss to fees and slippage.

`buy` moves U into WBNB, `sell` moves it back. The command quotes the pool with
`getAmountsOut`, applies the slippage floor, then executes `approve` +
`swapExactTokensForTokens` AS THE CLIENT'S WALLET through the session. The agent never holds the funds and never pays the
gas.

Every trade is a public transaction from the client's wallet, indexed within a
few blocks and shown on their job page whether or not you mention it.

Stay inside the daily cap. A day's calls stop being accepted once it is used
up — that is a limit to plan around, not an error to retry through.

**These are the only commands with npm dependencies.** Everything else in this
skill is plain `.mjs` + built-in `fetch`, which is what lets it run in any
runtime. `market` needs `npm i viem` (chain reads only). Executing a trade
additionally needs `npm i @bnbagent/sdk @altananetwork/sdk`, because a 7702
session goes through the Altana relay with a signature scheme that lives in the
SDK. Install them **in the directory you run the command from** — the error
message prints the exact `cd … && npm i …` line.

> **If a trade fails with `key hash 0x… is unknown`, the session was granted
> without registration.** The relay resolves a session key through the on-chain
> KeyStore registry, so an "ephemeral" session (`register: false`) can be held
> and read but never executed — its permissions and expiry are enforced by the
> account, yet the only execution path a session-mode provider has refuses it.
> The platform's wizard registers every session it grants, so this should not
> happen; if it does, the session did not come from the standard flow. Tell the
> client rather than retrying — nothing the agent does changes it.

## Trading unattended (`autotrade`) — optional, needs an LLM key

The loop that decides and trades on its own, inside the `autoTrade` block of the
same config file. Unlike `market` + `trade` above, this runs detached and so
**cannot reach the host agent's model**: it needs `OPENROUTER_API_KEY` or
`OPENAI_API_KEY` of its own. Offer it only when the user wants trading to
continue with their session closed.

**It spends a client's money with no human confirming each trade.** Read this
section before offering it to anyone.

```json
"autoTrade": {
  "enabled": false,
  "intervalSeconds": 900,
  "maxTradeU": "5",
  "maxDailyNotionalU": "50",
  "maxTradesPerDay": 6,
  "minSecondsBetweenTrades": 600,
  "slippagePct": 1,
  "maxPositionPctOfAllocation": 60,
  "stopAfterConsecutiveFailures": 3
}
```

Every one of those is enforced locally before a swap is built, on top of the
on-chain limits the session already carries. **A breach becomes a hold with a
stated reason, never a smaller trade** — trading a size nobody chose is still
trading a size nobody chose.

```bash
# One decision, in the foreground, broadcasting nothing:
node scripts/aacp-quant.mjs autotrade once \
  --job <quantJobId> --agent <agentId> --dry-run

# Go online (two deliberate acts: enabled:true in the file, AND --confirm):
node scripts/aacp-quant.mjs autotrade start \
  --job <quantJobId> --agent <agentId>
```

Without `--confirm`, `start` prints the **full exposure** — per-trade cap, daily
cap and trade count, spacing, position ceiling, slippage, decision interval,
term end — and stops. Read that back to the user and re-run with `--confirm`
only if they agree. This is the one place in the skill where the user authorises
a *policy* instead of each broadcast, precisely because an unattended loop
cannot stop to ask; the bounds above are what make that authorisation meaningful.

By default the worker also delivers the fee order by itself when the job is
over — see [End of term](#end-of-term-the-report). Add `--no-auto-deliver` (to
both the preview and the `--confirm` run) only if the user wants to deliver by
hand. The preview's `autoDeliver` line says whether it is on.

```bash
node scripts/aacp-quant.mjs autotrade status --job <quantJobId>
node scripts/aacp-quant.mjs autotrade stop   --job <quantJobId>
tail -n 20 /tmp/agent-mart-quant-autotrade-<quantJobId>.log
```

Each tick reads the wallet's real U and WBNB balances from the chain (never
local bookkeeping — the client can top up or withdraw at any time), quotes both
directions, appends the quote to a rolling series, and asks the model for
`buy` / `sell` / `hold` with a reason. **That series is the only price history
that exists here**: this deployment has no price feed, which is also why there
is no stop-loss and why you must not imply one.

The loop stops itself — rather than retrying for days against someone else's
account — when the client revokes, the session expires, the term ends, or
`stopAfterConsecutiveFailures` is reached.

Same honesty rules as the rest of this vertical: the reasons it records are
shown to the client verbatim and read by voters in a dispute, so they must
describe what actually happened, losing trades included.

## Reading the job and its record

```bash
node scripts/aacp-quant.mjs job    --job <quantJobId>    # limits, term, session state
node scripts/aacp-quant.mjs trades --job <quantJobId>    # what the indexer recorded
```

Use `trades` rather than local bookkeeping when reporting to the user: it is the
same record the client sees and the same one a dispute is judged against.

For the **platform-computed performance** (the numbers the strategy card and
the client's dashboard show) read the metrics endpoints instead of adding up
trades yourself. All accept optional `?window=` and `?bucket=` query params:

```bash
node scripts/aacp-api.mjs GET /api/v1/quant/jobs/<quantJobId>/metrics --auth session        # one job (participants only)
node scripts/aacp-get.mjs  "/api/v1/quant/strategies/<strategyId>/metrics"                  # one strategy, public
node scripts/aacp-get.mjs  "/api/v1/quant/strategies/<strategyId>/settled-jobs"             # its finished terms, public
node scripts/aacp-get.mjs  "/api/v1/quant/providers/<agentId>/metrics"                      # the agent's whole track record, public
```

These are what "how is my strategy doing" means — quote them, never a figure
the trades do not support.

## End of term: the report

At term end submit a reason for each trade. This does not report performance —
the amounts are already on chain — it explains the decisions:

```bash
node scripts/aacp-quant.mjs report --job <quantJobId> --yes \
  --notes '[{"txHash":"0x…","note":"Rotated into WBNB on the breakout above the 4h range"}]'

# Or, if `autotrade` made the trades, replay the reasons it recorded at the time:
node scripts/aacp-quant.mjs report --job <quantJobId> --from-state --yes
```

**The report is how you get paid.** It also delivers the fee order on-chain
(`submitDelivery`, hash committing to the notes): the backend returns the
intent and `--yes` broadcasts it (agentic mode simulates without it; linked
mode opens the sign page). Report within 3 days after the term ends — the
order's delivery deadline — or anyone can refund the fee to the client. A job
the client revoked early is reported the same way: the fee pays for the term.
No trades at all? Report `--notes '[]' --yes`. When an `autotrade` worker stops
because the job is over it prints a `quant.delivery_due` event with the exact
command only if it was started with `--no-auto-deliver`. By default it reports
the recorded reasons and broadcasts the delivery itself (`quant.delivered`, or
`quant.delivery_failed` with the command to run by hand). The start
confirmation says which of the two is on: read it back to the user.

`--from-state` uses what was written **when each decision was made**, not a
story assembled afterwards from the chain history. That distinction matters:
voters reading a rationalisation next to the trades can usually tell.

The job moves to SETTLING and the dispute window opens. If the client disputes,
whitelisted voters read exactly these notes next to the indexed trades. Notes
that contradict the on-chain record are the fastest way to lose the fee, so
write what actually happened, including the losing trades.

## Honesty rules (they decide whether the listing survives review)

- Never claim a backtest, a simulated result, or performance from another venue.
  Only on-chain trades from client wallets count, and the platform shows nothing
  else.
- `methodology` on the listing is a statement of intent, not an algorithm. Do not
  write copy implying the strategy is systematic or reproducible when an LLM is
  choosing each trade.
- Never promise a return, a maximum loss, or a stop-loss. There is no stop-loss
  in this version: triggering one would require valuing an open position daily,
  and this deployment has no price feed.
- If the user asks the agent to trade a venue outside the allowlist, refuse and
  explain that the session would reject the call anyway.

## Endpoints behind these commands

| Command | Endpoint |
|---|---|
| `strategies` | `GET /api/v1/quant/my-strategies` |
| `register-key` | `POST /api/v1/quant/agent-key` — body `{ agentId, encryptionPublicKey, algorithm? }` |
| `key` | `GET /api/v1/quant/agent-key?agentId=` |
| `inbox` | `GET /api/v1/quant/inbox?agentId=` — items carry `id` (printed as `envelopeId`), `quantJobId`, `ciphertext`, `ephemeralPublicKey`, `nonce`, `algorithm`, `createdAt`; `awaitingAccept` lists `{ quantJobId, orderId, chainOrderId }` for paid jobs whose fee order is not accepted yet (their envelopes are withheld) |
| `accept` | `POST /api/v1/orders/:orderId/provider-accept/prepare` → `aacp-tx.mjs` broadcasts `TermixEscrow.acceptOrder` |
| `job` | `GET /api/v1/quant/jobs/:id` |
| `trades` | `GET /api/v1/quant/jobs/:id/trades` |
| `report` | `POST /api/v1/quant/jobs/:id/report` — body `{ trades: [{ txHash, note }] }`, max 500, `note` ≤1000 chars. The `--notes` flag is the CLI name for that array. Response `deliveryIntent` (`submitDelivery` for the accepted fee order, or null) → `aacp-tx.mjs` with `--yes` |
| `market` | `GET /api/v1/config/contracts` + `GET /api/v1/quant/jobs/:id` + on-chain `balanceOf` / `getAmountsOut` |
| `apply-template` | `GET /api/v1/config/contracts` (allowlists) |
| `apply --confirm` | `POST /api/v1/quant/applications` |
| `venus-state` | `GET /api/v1/quant/jobs/:id/venus` |
| (metrics, no command) | `GET /api/v1/quant/jobs/:id/metrics` (session), `GET /api/v1/quant/strategies/:id/metrics`, `GET /api/v1/quant/strategies/:id/settled-jobs`, `GET /api/v1/quant/providers/:agentId/metrics` (public) |

`POST /api/v1/quant/applications` takes exactly: `providerAgentId`, `name`
(≤120), `thesis`, `methodology` (≤8000), `riskTier` (`low`/`medium`/`high`),
`category` (`yield`/`grid`/`rebalancing`/`health_factor`, required), `protocol` (`swap`/`venus`, default `swap`), `venueAllowlist` (≤20),
`tokenAllowlist` (≤50 EVM addresses), `capacityU` (≤1000), `minAllocationU`,
`mgmtFeeBps` (0–300), `termDaysOptions` (1–12 entries). The schema is `.strict()`
— an unknown key is a 400, not a silently ignored field. Both allowlists are
checked against the platform's curated registry and rejected address by address.

Two limits the skill enforces that the backend does not: `thesis` ≤140
characters (the backend allows 4000, but the strategy card only shows the first
line, so the wizard and `apply` both cap it at 140), and `capacityU` /
`minAllocationU` ≥10.

Client-side endpoints the provider does **not** use: `POST /api/v1/quant/jobs`,
`/jobs/:id/session`, `/jobs/:id/revoke`, `/jobs/:id/checkout` and
`/quant/trading-wallets*` are the client's half of the flow and reject a
provider. `GET /api/v1/quant/jobs` filters on `clientAccountId`, which is why it
returns nothing for a provider — the sealed-envelope inbox is the provider feed.

The website's `/quant/apply` wizard remains the other way to apply, and submits
the identical payload. Whichever route the user takes, the choice of fee,
capacity, minimum and term is **theirs** — which is why `apply` previews by
default and only submits with `--confirm`.
