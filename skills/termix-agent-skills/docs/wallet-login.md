# Wallet login — the Binance Agentic Wallet (default) and the private-key fallback

> **Registered on the website already?** Link this terminal to that account
> instead — no wallet or key here at all, and the agents from the website are
> the ones the skill uses: `node scripts/aacp-link.mjs start`, see
> [`link.md`](link.md). This document is for the skill's **own** wallet
> identity, a separate account.

Everything Termix asks a wallet to do — sign in, issue an A2A runtime token, send
an on-chain transaction — happens through **one** of three identities:

| Priority | Identity | What signs | Sees the web account's data | When to use |
|---|---|---|---|---|
| **1 — default** | **linked** (whenever a link exists) | Off-chain: the web account's API key. On-chain: **the user's web wallet, in the browser** | **yes** — the same account, agents, orders, wallet | The user registered on the website — see [`link.md`](link.md) |
| 2 | `TERMIX_WALLET_MODE=agentic` (default when not linked) | The Binance Agentic Wallet, via the `baw` CLI | **no** — a standalone account; nothing crosses to or from the web wallet | The user wants an identity that is independent of the website |
| 3 — lowest | `TERMIX_WALLET_MODE=key` | `WALLET_KEY`, a raw private key, signed locally | no (its own account, like agentic) | Only when the user explicitly does not want the link **or** a Binance wallet, or the wallet cannot sign on the selected chain |

**How the scripts pick.** A link file for the selected chain ⇒ linked, and
`TERMIX_WALLET_MODE` is not read at all. No link ⇒ agentic, unless
`TERMIX_WALLET_MODE=key` is set explicitly — a `WALLET_KEY` in the environment
on its own changes nothing. `node scripts/aacp-link.mjs identity agentic`
sets the wallet identity aside from an existing link; `identity linked` goes
back.

**Lead with linking, then the agentic mode.** Only bring up `WALLET_KEY` if the
user asks for it or says they will not use a Binance wallet. A private key
pasted into a chat or a shell command lands in the transcript, the shell history
and the process list; the agentic wallet's key never leaves the wallet, and every
signature is something the user can see and approve.

**Agentic is standalone — say so before the user picks it.** It logs in as its
own account under the Binance wallet's address. It does not see the agents,
orders or quant task wallets the user has on the website, cannot sign for the
web wallet, and the web wallet cannot sign for it; whatever is minted, earned or
derived here stays here. A user who already has things on the website almost
always wants the link instead.

---

## Agentic mode — the walkthrough to drive with the user

### 1. Check where things stand

```bash
node scripts/aacp-wallet.mjs status
```

One JSON blob: whether `baw` is installed and current, whether the wallet is
`CONNECTED`, the address on the selected chain, whether Developer Mode is on,
and a `hint` naming the next command. Run it before anything else — every
failure below is visible here first.

If `baw` is missing, tell the user what you are about to install and get a yes:

```bash
npm install -g @binance/agentic-wallet
```

### 2. Sign in

```bash
node scripts/aacp-wallet.mjs connect
```

This does the whole handshake and keeps the user informed while it runs:

- prints a **pairing code** and a link, and **opens the link in the browser**
  automatically (`xdg-open` / `open` / `start`; if that fails it says so and the
  link is still there to click);
- **blocks** while the user scans the QR in the Binance App, printing a
  "still waiting…" line every ~10 s with the pairing code repeated;
- re-checks `baw wallet status` afterwards, because the App saying "signed in"
  is not proof the CLI holds a session.

Tell the user, in this order: open the Binance App, scan the QR on the page that
just opened, **check the pairing code on screen matches the one printed here**,
and confirm. The code expires in about 5 minutes — if it does, run `connect`
again for a fresh one rather than retrying the old one.

### 3. Turn on Developer Mode — this is the one setting they must find

Signing a login, a runtime token or a transaction all count as *external
signing*, and external signing only works while **Developer Mode** is on.

**It can only be enabled inside the Binance App** — there is no CLI flag for it.
Walk the user there: Binance App → Agentic Wallet → settings → enable Developer
Mode. It expires after a while and has a **daily spend limit**; `status` reports
both `expiresAt` and `dailyLimit`/`quotaUsed`, so check there before telling the
user something is broken.

The scripts refuse to even preview a signature while it is off, and say exactly
this — they will not hand the user a raw CLI error code.

### 4. Log in to Termix

```bash
node scripts/a2a-runtime.mjs login
node scripts/a2a-runtime.mjs agents
```

`login` fetches the nonce, has the wallet sign the platform's EIP-712 typed data,
and caches a session token (0600, per chain). Report the address and handle —
never the token.

### 5. The Binance Agent ID — before the first agent

Right after the first login, run `node scripts/aacp-next.mjs`. On BSC mainnet, a
wallet with no agent yet lands on an `agent-id-*` stage:

- **No Agent ID yet** (`agent-id-missing`): recommend claiming one in the Binance App
  (Wallet → Agent ID banner, free, 3–15 lowercase letters/digits) **before** minting
  anything. It becomes the Termix agent itself, so there is no mint. Minting a `.agent`
  agent is the skip option.
- **Holds one** (`agent-id-unactivated` / `agent-id-unindexed`): ask once, then
  activate it. It is free, with no transaction.

Details: [`binance-agent-id.md`](binance-agent-id.md).

From here the rest of the skill is unchanged: `aacp-watch.mjs wait`,
`a2a-runtime.mjs reply`, the client/provider workflows. None of them need a key.

---

## On-chain transactions in agentic mode

`scripts/aacp-tx.mjs` takes the same tx-intents as before, but the Binance wallet
signs and broadcasts them, in two steps:

```bash
# 1. Simulate. Prints balance / allowance / authority changes and risk flags.
node scripts/aacp-tx.mjs --intents '<json[]>'

# 2. Only after the user has seen that and said yes:
node scripts/aacp-tx.mjs --intents '<json[]>' --yes
```

Without `--yes` nothing is broadcast. Show the user the simulated changes and any
risk items from step 1 — that is what they are approving. Multi-intent batches
(`approve` + `deposit`) run in order and wait for each receipt before the next.

If the wallet answers `PENDING_CONFIRMATION`, the transaction needs a tap in the
Binance App before it exists on-chain. The script stops the batch, prints the
`orderId`, and the hash shows up afterwards via `baw wallet tx-history --json`.

`--dry-run` still works and never touches the wallet at all.

---

## Limits and failure modes

**Mainnets only, and only the ones the wallet lists.** Which chains the Binance
Agentic Wallet can sign on is decided on Binance's side (`baw wallet chains`;
BSC 56, Base 8453 and Robinhood 4663 among them at the time of writing) and it
supports **no testnets**. The scripts check that list live before every
signature and, when the selected chain is absent, refuse with the wallet's own
list and the two ways forward — link the web account
(`node scripts/aacp-link.mjs start`, the user's browser wallet signs) or
`TERMIX_WALLET_MODE=key`. Against a testnet build they fail the same way.

**Listed is not the same as signable — Robinhood.** The wallet lists Robinhood
(4663) and holds an address there, but as of 2026-09-08 its risk service refuses
**every** external-signing request on that chain with
`Transaction risk is too high and has been rejected: blocked` (code `351803`):
the EIP-712 login, `contract-call preview`, even a read-only `balanceOf` — while
the identical request from the same wallet passes on BSC and Base. It is not
about the transaction and no setting changes it. The scripts add that
explanation to the error; the answer under `AACP_CHAIN=rh` is to **link the web
account** ([`link.md`](link.md)) or use `TERMIX_WALLET_MODE=key`. Re-check
occasionally with `node scripts/a2a-runtime.mjs login` — if Binance lifts the
block, agentic mode starts working on Robinhood with no skill change.

**BSC refuses some approvals.** On BSC the same error comes back for ERC-20
`approve` calls whose spender is TermixEscrow (USDC and USDT) or the USDT
TermixStaking contract, as of 2026-10-27. Approvals to the USDC staking contract,
SplitVault and CampaignVault pass, and so do plain contract calls such as
`acceptOrder` and `submitDelivery`. So the agentic wallet can sell and can stake
USDC, but cannot fund an order or stake USDT. Buy from the linked web account or
key mode. The full table is in [`binance-agent-id.md`](binance-agent-id.md).

**Backends that predate EIP-712.** The agentic wallet cannot produce the EIP-191
`personal_sign` signature older Termix backends expect. When that is the case:

- `login` says the backend "does not offer EIP-712 wallet login yet" (it detects
  the missing `typedData` in the nonce response) rather than failing on a
  signature mismatch;
- `token` / hosting adds the same explanation to the 401.

Relay it as written. The fix is either a backend that has shipped the change, or
`TERMIX_WALLET_MODE=key` on that chain — not a retry.

**Wallet not connected / status `CREATING`.** Run `connect` (or wait a few
seconds and re-check). `baw auth signout` ends the session; `connect` starts a
new one.

**Signature stuck at `PENDING_CONFIRMATION`.** The wallet routed it to the App
for approval. The script polls and keeps saying so; the user just needs to
approve it there. `REJECTED` / `EXPIRED` means no signature was produced.

---

## Key mode — lowest priority, only when the user wants neither the link nor the agentic wallet

```bash
export TERMIX_WALLET_MODE=key
WALLET_KEY=0x... node scripts/a2a-runtime.mjs login
WALLET_KEY=0x... node scripts/aacp-watch.mjs wait --agent <agentId>
WALLET_KEY=0x... node scripts/aacp-tx.mjs --intents '<json[]>'
```

The key is used locally to sign (EIP-191 for login and runtime tokens, EIP-1559
for transactions) and is never sent anywhere. Both variables must be set: without
`TERMIX_WALLET_MODE=key` the scripts still take the agentic path and ignore
`WALLET_KEY`.

Never print the key, echo it back, or write it into a file the user did not ask
for. Prefer `export WALLET_KEY=...` in the user's own shell over asking them to
paste it into the conversation.
