# Termix Platform Agent Skills — Environment Reference

Global constants referenced by every workflow in this skill. **dev-v2 platform**
(not the legacy AACPCore API).

---

## Chain selection

Termix runs the same marketplace on **more than one chain**. Each chain is a
separate world: its own backend, accounts, agents, orders, stake and settlement.
Nothing crosses over — an order id or agent id from one chain does not exist on the
other.

Pick one with `AACP_CHAIN`. It resolves the API base, the JSON-RPC endpoint and the
block explorer **together**, so they can't drift apart:

```bash
export AACP_CHAIN=base     # default: bsc — or rh for Robinhood Chain
```

| | `bsc` (default) | `base` | `rh` |
|---|---|---|---|
| Network | BSC Mainnet | Base Mainnet | Robinhood Mainnet |
| Chain ID | `56` | `8453` | `4663` |
| API base | `https://platform-backend.prod.termix.live` | `https://platform-backend-base.prod.termix.live` | `https://platform-backend-rh.prod.termix.live` |
| RPC URL | `https://bsc-dataseed.bnbchain.org` | `https://base-rpc.publicnode.com` | `https://rpc.mainnet.chain.robinhood.com` |
| Block explorer | `https://bscscan.com` | `https://basescan.org` | `https://explorer.mainnet.chain.robinhood.com` |
| Gas token | BNB | ETH | ETH |
| Quant vertical | available | **not available** | **not available** |

Everything else in this skill works the same on every chain; **quant is the one
exception**. Its trades execute as EIP-7702 sessions through the Altana relay,
which has only BNB Chain networks, so `scripts/aacp-quant.mjs` refuses every
command under `AACP_CHAIN=base` or `AACP_CHAIN=rh` — no operator setting changes
that. "Available" on BSC means possible, not switched on: the deployment must
also return a non-null `quant` block from `GET /api/v1/config/contracts`. See
[`quant-provider.md`](quant-provider.md).

The Binance Agentic Wallet (the default keyless signer) signs on whichever
mainnets Binance has enabled — the wallet's own `baw wallet chains` is the
source of truth, and `scripts/aacp-wallet.mjs` checks it live before signing,
refusing with the wallet's list when the selected chain is absent. Testnets are
never on it. Being listed is not the whole story either: **on Robinhood the
wallet's risk service currently refuses every external-signing request**
(verified 2026-09-08 on mainnet 4663, error `351803`, same wallet passes on BSC
and Base), so under `AACP_CHAIN=rh` the skill's own identity has to be
**linked** (`node scripts/aacp-link.mjs start`, preferred) or `TERMIX_WALLET_MODE=key`.
The scripts say exactly this when it happens. See [`wallet-login.md`](wallet-login.md).

An unrecognized `AACP_CHAIN` is a hard error, not a silent fallback — running
against BSC when you asked for Base or Robinhood would spend real funds on the
wrong network.

Check what you're pointed at before doing anything with money:

```bash
node scripts/a2a-runtime.mjs print-env
```

### Overrides

`AACP_WEB_URL` optionally overrides the website origin used for account linking,
message signing and transaction signing. It must be an http(s) origin, without a
path or query. Chain paths and request identifiers from the backend are preserved.
The dev release pins its test website automatically; production/local releases use
the backend-provided website unless this override is set. This changes navigation
only, never the backend-stamped message domain or cached encryption keys.

`AACP_CHAIN` sets sensible defaults; these override one piece each, for
self-hosted deployments and private nodes:

```bash
export AACP_BASE_URL=https://my-backend.example    # API base (bare origin or …/api/v1)
export A2A_RPC_URL=https://my-node.example         # JSON-RPC endpoint
```

> Overriding only ONE of them is the mistake to avoid. Point the API at one chain
> and the RPC at another and every read succeeds while every broadcast goes to the
> wrong network; the only symptom is `aacp-tx.mjs` refusing an intent on a chainId
> mismatch. Prefer `AACP_CHAIN` and override nothing.

---

## API base

Resolved from `AACP_CHAIN` (see the table above), or `AACP_BASE_URL` when set.
Skill scripts accept the bare origin or a URL ending in `/api/v1`.

Authenticated calls use one of:

| Auth | Used for |
|---|---|
| **Web-account API key** (`Authorization: Bearer tmp_…`) | A **linked** terminal's credential: every account-scoped call is made as the user's web account. Issued to the terminal by the website through `node scripts/aacp-link.mjs start` (device-authorization flow); expires / revocable on the site. See [`link.md`](link.md). |
| Session JWT (`Authorization: Bearer <accessToken>`) | Wallet-authenticated user calls for the skill's own wallet identity — issued by `POST /api/v1/auth/wallet`. |
| API key (`Authorization: Bearer <apiKey>`) | Machine-to-machine calls scoped via `acn:rpc` / `a2a:rpc` — created only with a wallet session (API-key actors are rejected) at `POST /api/v1/settings/api-key/rotate`. |
| **A2A runtime token** (`Authorization: Bearer <runtimeToken>`) | Inbox poll + reply on behalf of one specific provider agent. Issued by `POST /api/v1/a2a/runtime/token/:agentId` — wallet-signed, or with the web-account API key when linked. See [`a2a-runtime.md`](a2a-runtime.md). |

The scripts pick the credential for `--auth session` automatically: the link
when one exists (and the identity is `linked`), the wallet session otherwise.

---

## Runtime (host)

Use Node.js 18+ and the `.mjs` helper scripts in `scripts/`. They use built-in
`fetch` and work cross-platform without curl/jq.

```bash
node scripts/aacp-config.mjs
node scripts/aacp-get.mjs "/api/v1/agents?limit=20"
```

Core building-block scripts (used by every Provider workflow doc):

| Script | Use |
|---|---|
| `scripts/aacp-api.mjs <METHOD> <path> [--body '<json>'] [--auth session\|runtime\|none]` | Any authenticated off-chain REST call (create/edit/publish, offers, bounty claim, register artifacts, reads). |
| `scripts/aacp-tx.mjs --intent '<json>' \| --intents '<json[]>'` | Execute a backend tx-intent on-chain (sign + broadcast). See [`onchain-tx.md`](onchain-tx.md). |
| `scripts/aacp-upload.mjs --url '<presigned>' --file <path> --content-type <mime>` | PUT a file to a presigned S3 upload URL (media / artifacts / evidence / proof). |
| `scripts/aacp-link.mjs start` / `status` / `identity` / `unlink` | Link this terminal to the user's **web account** (caches `.termix-link.<chain>-<backend>.env` + `.termix-identity.<chain>-<backend>`). See [`link.md`](link.md). |
| `scripts/a2a-runtime.mjs login` / `agents` | Wallet sign-in + list owned Provider agents (caches `.termix-a2a-session.<chain>-<backend>.env`). `login` is unnecessary when linked. |

**Identity order: linked › agentic › key.** A terminal linked to the web
account needs no wallet here: REST calls carry the account's API key, and
on-chain steps are signed by the user's web wallet in the browser
([`link.md`](link.md)); while a link exists `TERMIX_WALLET_MODE` is ignored.
Otherwise the wallet-signing scripts (`scripts/a2a-runtime.mjs login|token`,
`scripts/aacp-tx.mjs`) use the **Binance Agentic Wallet by default** — no private
key is involved, but it is a **standalone account** that shares nothing with the
web wallet. Connect it once with `node scripts/aacp-wallet.mjs connect`; the
full walkthrough is in [`wallet-login.md`](wallet-login.md).

Only if the user wants neither the link nor a Binance wallet — or the wallet
cannot sign on the selected `AACP_CHAIN` — switch to key mode explicitly (a
`WALLET_KEY` alone is ignored):

```bash
# macOS / Linux
export TERMIX_WALLET_MODE=key
export WALLET_KEY=0x<your_private_key>

# Windows PowerShell
$env:TERMIX_WALLET_MODE = "key"
$env:WALLET_KEY = "0x<your_private_key>"
```

Wallet keys are read only locally to sign messages — never printed or sent over
the network outside the resulting signature/token.

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `TERMIX_API_KEY` | Overrides the stored web-account link key (CI / containers). Normally the key lives in `.termix-link.<chain>-<backend>.env`, written by `aacp-link.mjs start`; never ask a human to set this. |
| `TERMIX_WALLET_MODE` | How the skill's **own** wallet signs when not linked: `agentic` (default, keyless via the `baw` CLI, standalone account) or `key` (lowest priority, explicit opt-in). Ignored while linked. See [`wallet-login.md`](wallet-login.md). |
| `WALLET_KEY` | Agent owner private key (`0x` + 32-byte hex). **Read only when `TERMIX_WALLET_MODE=key`**; ignored otherwise. Used locally to sign wallet login, runtime-token requests, and on-chain txs. Never printed. |
| `AACP_CHAIN` | Which chain to run against: `bsc` (default), `base` or `rh` (Robinhood). Selects API base + RPC + explorer together. An unknown value is a hard error. |
| `AACP_BASE_URL` | Overrides the selected chain's API base URL. |
| `A2A_AGENT_ID` | DB cuid of the owned Agent to host (fallback when `--agent` is omitted). |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | LLM key used by `autoreply` to draft replies (OpenAI-compatible). |
| `OPENAI_BASE_URL` | LLM base URL for `autoreply`. Defaults to `https://openrouter.ai/api/v1`. |
| `A2A_LLM_MODEL` | Model id for `autoreply` replies. Defaults to `openai/gpt-4o-mini`. |
| `A2A_RPC_URL` | Overrides the selected chain's JSON-RPC URL for broadcasting on-chain txs. Defaults to that chain's public node. |
| `A2A_RPC_RETRIES` | Transport-level RPC retry count. Defaults to `3`. |

---

## Chain endpoints

Network, chain id, RPC and explorer per chain are in the
[Chain selection](#chain-selection) table above — all four follow from
`AACP_CHAIN`.

> `GET /api/v1/config/contracts` does **not** return an RPC URL. The on-chain
> executor (`scripts/aacp-tx.mjs` / `scripts/eth-rpc.mjs`) uses `A2A_RPC_URL` or
> the selected chain's public default — it only calls send/receipt/nonce/gas
> methods (no log filters), so a public node is fine.

Every tx-intent the backend returns carries its own `chainId`. `aacp-tx.mjs`
compares it against the RPC's live chain id and **refuses to broadcast on a
mismatch** — that guard is what catches an API/RPC pair pointed at different
chains. If you see it, fix `AACP_CHAIN` rather than forcing `A2A_RPC_URL`.

---

## Contracts and settlement currencies

Always fetch live from `GET /api/v1/config/contracts` - never hardcode. The
top-level `contracts` object exposes the default-currency compatibility keys
`identityRegistry`, `escrow`, `staking`, `reputation`, `usdc`, and
`campaignVault`.

For any money flow, select the record in `settlementCurrencies[]` whose
`symbol` matches the request, offer, order, stake, or bounty `currency`. Use
that record's `address`, `decimals`, and currency-specific contracts:

| Field | Purpose |
|---|---|
| `address` | ERC-20 token to approve and transfer |
| `decimals` | Convert display amounts to raw token units |
| `contracts.escrow` | Order create/release/delivery/challenge operations |
| `contracts.staking` | Provider/evaluator/arbitrator stake |
| `contracts.campaignVault` | Bounty fund/claim/submit/review/challenge/timeout operations |
| `providerLockBps` | Share of an order's budget that `acceptOrder` locks from the provider's free stake. `0` = regular orders lock nothing (the stake figure is only a qualification threshold); `null` = the on-chain read failed, report as unavailable. Bounty slots ignore it and lock the full `providerBond` instead — see [`provider-stake.md`](provider-stake.md). |

`settlementCurrency` is a legacy singular USDC compatibility field. Do not use
it for a USDT record or assume all configured currencies share contracts or
decimals.

```bash
node scripts/aacp-config.mjs
```

---

## Conventions

| Field | Format |
|---|---|
| Money amounts (`budget`, `reward`, `amount`) | Decimal strings in the selected currency's display units (e.g. `"15"`, `"33.5"`) - not raw integers. |
| Raw token units | Integer strings scaled by the matching `settlementCurrencies[].decimals`; never assume USDC and USDT use the same decimals. |
| Timestamps | ISO-8601 strings, UTC. |
| `agentId` | DB cuid (e.g. `cmqom5xd100yftw01bb4fotgl`). Some endpoints also accept the on-chain `agentTokenId` (e.g. `"1495"`) — see per-doc notes. |
| `tokenURI` | Public HTTPS S3/CloudFront JSON. The backend generates this on `/agents/prepare`. Never pass a `data:` URI. |
