# On-chain transactions (tx-intents)

Some Provider actions require a real on-chain transaction. The backend never
broadcasts for you — its `*/prepare`, `*/deposit-intent`, `*/submit` endpoints
return an **unsigned tx-intent** that the wallet must sign and broadcast. The
backend already ABI-encodes the call, so you only sign + send.

## tx-intent shape

```json
{ "action": "submitDelivery", "chainId": "<selected-chain-id>",
  "contract": "0x…",  "callData": "0x…",  "value": "0",
  "id": "…", "status": "PREPARED", "nonceKey": "…" }
```

The backend returns `chainId` as an integer for the chain selected by
`AACP_CHAIN`; do not copy the placeholder value from this shape.

Agent-mint returns the same idea with slightly different keys
(`{ contract, callData, to, tokenUri, metadataHash, metadata }`). The executor
accepts both `contract`/`to` and `callData`/`data`.

## Execute with `scripts/aacp-tx.mjs`

Who signs depends on the active identity. **Linked** to the web account
([`link.md`](link.md)) → the user's web wallet signs in the browser, see
[Linked mode](#linked-mode) below. Otherwise signing follows
`TERMIX_WALLET_MODE` — the keyless Binance Agentic Wallet by default,
`WALLET_KEY` only if the user does not want it. See
[`wallet-login.md`](wallet-login.md). The first stderr line names the mode:
`[aacp-tx] mode=linked|agentic|key …`.

### Linked mode

`aacp-tx.mjs` does not sign. It turns the intents into one **signature
request** on the website, opens `<site>/sign?id=…` in the browser, and blocks
until the user has signed there with the wallet that owns the account:

```bash
node scripts/aacp-tx.mjs --intent '<intent-json>' --context '{"orderId":"<orderId>"}'
node scripts/aacp-tx.mjs --intents '[<approve-intent>,<deposit-intent>]'      # one request, signed in order
```

- **`--yes` is not a gate here** (accepted, ignored): the page simulates each
  transaction and the wallet shows the user what they are signing — that
  signature *is* the confirmation. Still tell the user what is about to be
  requested before running the command, and read the chain line back to them.
- `--context '<json>'` (optional) carries business ids (`orderId`, `agentId`,
  `campaignId`…) that the sign page turns into links so the user can see what
  they are signing for.
- `--dry-run` prints the plan and creates **no** request.
- The script prints the URL, tries to open it, then prints "still waiting…"
  every ~10 s. The request also appears under the pending-signatures badge in
  the website header. It expires after 15 minutes; Ctrl-C cancels it.
- Multi-intent batches are one request; the page executes them in order and
  waits for each receipt before the next.
- Output has the **same shape** as the other modes, plus `signRequestId` and
  `url`:
  `{ mode:"linked", from:<web wallet>, chainId, signRequestId, url, results:[{ action, txHash, status, blockNumber }] }`.
  Receipts are awaited on our own RPC, so a revert still fails loudly.
- Outcomes that stop the flow, verbatim: *"The user declined … in the
  browser"* (rejected in the wallet — do not retry unasked), *"Nobody signed
  within 15 minutes"* (re-run when they are ready), *"The web-account link is
  expired or revoked"* (`aacp-link.mjs start` again).

After the hashes come back, the confirm / poll steps in the table further down
are yours to run, exactly as in the other modes.

### Agentic and key modes

```bash
# 1. Simulate. Prints the balance / allowance / authority changes and risk flags.
node scripts/aacp-tx.mjs --intent '<intent-json>'

# 2. Broadcast, after showing that to the user and getting a yes.
node scripts/aacp-tx.mjs --intent '<intent-json>' --yes

# several intents in order (e.g. approve then deposit) — each receipt is awaited
# before the next one is simulated
node scripts/aacp-tx.mjs --intents '[<intent1>,<intent2>]' --yes

# print the plan without touching the wallet at all
node scripts/aacp-tx.mjs --intent '<intent-json>' --dry-run
```

**`--yes` is the confirmation gate in agentic mode**: without it the script
simulates every intent and stops. That simulation — not the raw calldata — is
what you show the user. In key mode there is no simulation step and the intent
broadcasts directly, so confirm before running it at all.

If the wallet answers `PENDING_CONFIRMATION`, the transaction is waiting for a tap
in the Binance App; the script stops the batch and prints the `orderId`, and the
hash appears afterwards via `baw wallet tx-history --json`.

Output: `{ mode, from, chainId, results:[{ action, txHash, status:"success", blockNumber }] }`.
The script estimates gas (+20%), fetches EIP-1559 fees (floored to the network
`eth_gasPrice` so chains that quote a low priority fee are not underpriced), waits
for the receipt, and **fails loudly if the tx reverts**.

Transient RPC failures (public nodes dropping the connection — `fetch failed`,
`ECONNRESET`, 5xx) are **retried automatically** with backoff (`A2A_RPC_RETRIES`,
default 3); definitive errors (revert, nonce too low) are not. Broadcast is
idempotent — a resend after a lost response is recognized as already-broadcast and
returns the same hash — so you should not manually re-run on a transient error.

### Which chain it broadcasts to

`AACP_CHAIN` picks the RPC, and the first stderr line of every run names it:

```
[aacp-tx] chain=base (Base Mainnet) rpc=https://base-rpc.publicnode.com intents=1
```

Read that line back to the user before broadcasting. Each intent carries its own
`chainId`; the script compares it against the RPC's live chain id and **refuses to
broadcast on a mismatch**, which is what catches an API pointed at one chain and an
RPC at another. Fix `AACP_CHAIN` — do not paper over it with `A2A_RPC_URL`. See
[`env.md`](env.md#chain-selection).

## After broadcast — let the indexer confirm

DB state is updated by the indexer from the on-chain event, NOT by broadcasting.
Poll the matching read endpoint until it flips:

| Action | Confirm / poll |
|---|---|
| Agent mint (`registerAgent`) | `GET /api/v1/agents/by-tx/:txHash` → `status: "CONFIRMED"` |
| Any tx-intent | `GET /api/v1/onchain/tx/:txHash` (generic indexer status) |
| Checkout `createOrder` | `POST /api/v1/checkout/:id/confirm { txHash }` |
| Bounty fund | `POST /api/v1/campaigns/:id/confirm-funded { txHash }` |
| Bounty claim | `POST /api/v1/campaigns/slots/claim/confirm { txHash }` |
| Bounty proof submit | `POST /api/v1/campaigns/slots/submit/confirm { txHash }` |
| Bounty approve / changes / reject | matching `/campaigns/slots/:slotId/confirm-* { txHash }` |
| Bounty challenge / finalize reject | re-read the slot and dispute until the indexer changes status |
| Delivery / dispute settle | re-read `GET /api/v1/orders/:id` / `GET /api/v1/disputes/:id` until status changes |

## Rules

1. **Confirm with the user before broadcasting** any value-bearing tx (mint gas,
   USDC approve/deposit/escrow). Agentic mode: run without `--yes` first and
   show them the simulated changes. Linked mode: say what you are about to
   request, then run it — their signature in the browser is the confirmation.
   `--dry-run` shows the plan without involving any wallet or website.
2. Never print `WALLET_KEY` or full tokens.
3. Do **not** re-broadcast the same intent on timeout — poll
   `GET /api/v1/onchain/tx/:txHash` and trust the receipt. tx-intents are
   idempotent server-side (`nonceKey`); re-calling the prepare endpoint reuses
   the same intent.
4. **Funding**: the wallet needs the native gas token selected by `AACP_CHAIN`
   (BNB on BSC; ETH on Base and Robinhood) and the selected settlement token (`USDC` or
   `USDT`) for staking / escrow. A bare wallet with no native gas token cannot
   broadcast anything. In linked mode that wallet is the user's **web** wallet —
   the one signing in the browser — not anything held here.
5. Token amounts in API bodies are decimal display units (`"15"`). Read the
   selected currency and its decimals from `/api/v1/config/contracts`; the
   backend encodes raw units into `callData`.
