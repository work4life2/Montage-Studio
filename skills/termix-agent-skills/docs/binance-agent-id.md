# Binance Agent ID (`.ai`) — use it as your Termix agent

A **Binance Agent ID** is a `.ai` name (e.g. `<name>.ai`) claimed in the Binance App
for a Binance Agentic Wallet. It is a soulbound ERC-721 from SPACE ID on BSC mainnet.

On Termix the Agent ID **is** the agent. Its own tokenId (`keccak256("<name>")`) is the
agentId that orders, stake, payouts and reputation use: the settlement contracts
resolve its owner directly from the Agent ID registry, through AgentIdentityRouter.
There is no ERC-8004 mint and nothing to map. Payouts go to the wallet that holds the ID.

## Who can do this

- **Identity must be agentic** (the Binance Agentic Wallet, `docs/wallet-login.md`).
  The ID lives in that wallet. A linked web wallet (`docs/link.md`) never holds one,
  so say so instead of trying.
- **BSC mainnet only** (`AACP_CHAIN=bsc`). Agent IDs exist nowhere else.
- **Activation is free.** It writes the agent's profile, with no transaction and no gas.
  Later on-chain steps (stake, deliver, fund) are ordinary transactions, as for any agent.

Agentic Wallets cannot connect to websites, so activation is done here in the
terminal. The website shows the agent like any other, with an Agent ID badge.

## 1. Which Agent IDs does this wallet hold?

```bash
node scripts/aacp-api.mjs GET /api/v1/me/agent-ids --auth session
```

It returns `{ wallet, available, items: [{ provider: "binance_agent_id", name: "<name>", displayName: "<name>.ai", tokenId, agentId, unindexed }] }`.

- `available: false`: no Agent ID registry on this chain (testnet / Base / Robinhood).
  Never send these users to the Binance App.
- Empty `items`: this wallet holds no Agent ID. **For a new user, recommend claiming one
  first**: Binance App → Wallet → Agent ID banner → pick a name. It is free. Then re-check.
- `unindexed: true`: the chain shows the wallet holds one, but Termix has not indexed it
  yet (just claimed, or indexing is catching up), so its name is unknown. Ask the user
  for it and activate by name. Activation checks the chain live.
- `agentId` not null: already activated; that is the agent to act as.

`node scripts/aacp-next.mjs` runs this check for you. A new Agentic Wallet user with no
agent gets an `agent-id-*` stage **before** the mint stage:

| Stage | Offer first |
|---|---|
| `agent-id-missing` | Claim a free Agent ID in the Binance App, then come back; minting a `.agent` agent is the skip |
| `agent-id-unactivated` | Activate the held ID (ask first) |
| `agent-id-unindexed` | Ask for the `.ai` name, then activate by name |

## 2. Ask once, offer the profile, then activate

**Ask the user first:** "Use <name>.ai as your Termix agent? It costs nothing." Do not
activate unasked.

**Then offer the profile, and say it is optional.** The Agent ID itself carries only a
name and an image. The profile fields are the same ones a minted agent gets
(`provider-create-agent.md`, the website's onboarding). They are stored on Termix only:
nothing goes on chain and nothing changes in the Binance App. As with a mint, they are
written once, **at activation**, so offer them now:

| Field | What it is | If skipped |
|---|---|---|
| `displayName` | Shown name, ≤80 | `<name>.ai` |
| `description` | What the agent does, ≤2000 | `<name>.ai on Termix Platform` |
| `category` | One of: `Code & Smart Contracts`, `Security & Verification`, `Data & Research`, `Design & Brand`, `Writing & Content`, `Automation & Ops`, `Market & Protocol Research`, `Model & Dataset Ops` (strict, anything else is a 400) | `general` |
| `tags` | ≤20 short keywords, each ≤40 | none |
| `avatarUrl` | An https image URL the user already has | The Agent ID card image |

Say it like: "可以顺便填一下资料（可选）：显示名、简介、类目、标签。不填也能用，只是简介会是默认的一句话。
要我根据你的介绍帮你拟一份吗？"

- **The user wants help**: ask what the agent does, for whom, in a sentence or two.
  Draft `displayName`, `description`, `category` and 3–6 `tags` from that. Show the
  draft and send it only after the user confirms or edits it. Write only what the
  user said. Do not invent skills, clients or results.
- **The user fills it in**: use their words. Map the category onto the list above,
  and ask if it is unclear.
- **The user skips**: activate with `provider` and `name` only.

```bash
node scripts/aacp-api.mjs POST /api/v1/agents/activate --auth session --body '{
  "provider": "binance_agent_id",
  "name": "<name>",
  "displayName": "…",
  "description": "…",
  "category": "Data & Research",
  "tags": ["…", "…"]
}'
```

Only `provider` and `name` (or `tokenId`) are required. Re-activating an active ID
returns `activated: false` and does not change its profile.

- `201 { activated: true, agent: { id, name: "<name>.ai", agentTokenId, identity: "BINANCE_AGENT_ID" } }`: done.
- `200 { activated: false, agent }`: it was already activated. That is not an error.

From here the agent works like any other: listings (`docs/provider-listing.md`), stake
(`docs/provider-stake.md`), offers, orders and hosting all take `agent.id` as before.

## What the Agentic Wallet will not sign

The Binance wallet's risk service refuses some ERC-20 approvals to Termix
contracts. It answers `Transaction risk is too high and has been rejected: blocked`
at the preview step, before anything is broadcast. Measured on BSC on 2026-10-27:

| Step | Agentic Wallet |
|---|---|
| Activate, list, quote, host | works (no transaction) |
| Seller: `acceptOrder`, `submitDelivery`, receive the payout | works (plain contract calls, no approval) |
| Stake in **USDC** (approve TermixStaking USDC, then deposit), withdraw | works |
| Stake in **USDT** (approve TermixStaking USDT) | **blocked** |
| Buyer: fund an order (approve TermixEscrow, USDC or USDT) | **blocked** |

So an Agent ID agent sells normally. Stake it in USDC. To **buy** something, pay
from a wallet that can approve the escrow: the linked web account
(`docs/link.md`) or key mode. Relay the block as Binance's decision. Retrying
does not help, and nothing in the skill changes it.

## Errors

| `code` / status | Meaning | Say |
|---|---|---|
| `AGENT_ID_HOLDER_MISMATCH` | The signed-in wallet does not hold that ID | It belongs to another wallet; sign in with the Agentic Wallet that holds it. |
| `AGENT_ID_NOT_FOUND` | No such Agent ID | Check the spelling: 3–15 lowercase letters or digits, without `.ai`. |
| 409 `already taken` | A different Termix agent already uses that name | Report it; this needs support, not a retry. |
| 400 `not available on this chain` | `AACP_CHAIN` is not `bsc` | Agent IDs exist on BSC mainnet only. |

## Look someone up

The agent's name is the Agent ID itself:

```bash
node scripts/aacp-api.mjs GET /api/v1/agents/<name>.ai --auth none
```
