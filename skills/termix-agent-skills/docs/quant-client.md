# Quant client — take a quant job (接单)

Use this when the user wants **their money traded by someone else's quant strategy**
— the client side of `quant-provider.md`. Runs from the terminal, no raw private key.
Mirrors the website's `/quant/new` wizard.

**Two identities produce the derivation signature (pick by how you signed in):**

| Identity | Signs with | Task wallets | Chains |
|---|---|---|---|
| **agentic** (`a2a-runtime.mjs login`) | Binance Agentic Wallet (EIP-712) | its own set | BSC **mainnet only** (agentic can't sign testnets; Altana relay is BNB-only) |
| **link** (`aacp-link.mjs start`) | the browser **web wallet**, via a `/sign?id=` MESSAGE request (personal_sign) | **SAME as the website** (byte-for-byte) — start on web, sweep from terminal, or vice-versa | any chain the web wallet supports, incl. **testnets** |

In **link** mode the derivation, funding txs, and fee escrow all sign in the browser
(the existing `/sign` page); the terminal only orchestrates. In **agentic** mode the
Binance App signs. Everything else (HD derive, 7702 grant with the local derived key,
REST) is identical.

## Model

- The **principal** lives in a per-job **task wallet** the client alone can empty —
  never escrowed, never sent to the agent.
- The task wallet is **HD-derived from ONE deterministic agentic EIP-712 signature**
  (`quant-task-wallet.mjs`). The same signature always re-derives it — it is the only
  recovery credential, so it must be deterministic (gate below).
- The **derived key** (local, in-memory only) signs the **EIP-7702 upgrade + Altana
  session grant**. The agent gets a restricted session key (venue allowlist + daily
  cap + expiry).
- The **login (agentic) wallet** pays two real-money things: the principal transfer
  into the task wallet, and the **management-fee escrow** (ERC-8183).
- Backend stores only `{derivationIndex, address}` — never a key.

Not the same wallets as the website: baw signs EIP-712 (not the web's personal_sign),
so agentic-derived task wallets are a distinct set under the agentic login identity.

## Prerequisites

- **agentic**: `baw` connected (`aacp-wallet.mjs connect`), **Developer Mode ON**, BSC mainnet, session via `a2a-runtime.mjs login`.
- **link**: `node scripts/aacp-link.mjs start` (browser approves) — the web wallet then signs every derivation / tx / escrow in the `/sign` page. `derive`/`fund`/`deliver` open the browser and wait.
- Funds in the agentic wallet:
  - **U** (`quant.token`) — the principal, transferred to the task wallet.
  - **BNB** — gas (task-wallet 7702/register + the wallet's own transfers).
  - **USDC** (`0x8AC7…Cd580d` on BSC) — a small amount for the **management-fee escrow**.
    The fee settles in the platform escrow currency (USDC), NOT the quant "U" token, so
    the wallet needs a little USDC on top of U. Fee ≈ `allocationU × mgmtFeeBps/1e4 × termDays/365`
    (e.g. 10 U / 1.5% / 7d ≈ 0.003 USDC).
- Deps in cwd (same as trading): `npm i viem @bnbagent/sdk @altananetwork/sdk`.
- The client account must own **≥1 agent** (needed at `checkout` as `clientAgentId`).

## Commands (in order; each real-money step is preview-first)

`node scripts/quant-client.mjs <cmd> [flags]`

| Cmd | Flags | Money? | Effect |
|---|---|---|---|
| `client-strategy` | `--strategy <id>` | no | Show fee/min/term/allowlist |
| `derive --verify` | | no | **Determinism gate** — run, then `baw` signout+reconnect, run again until `crossSession: PASS` |
| `allocate` | `--strategy <id>` | no | Server allocates the HD index |
| `register` | `--index <n>` | no | Derive + register the task-wallet address |
| `fund` | `--index <n> --allocationU <U> [--gas-bnb 0.02] [--yes]` | **YES** | Transfer principal U + gas BNB to the task wallet |
| `create` | `--strategy <id> --index <n> --allocationU <U> --dailyCapU <U> --termDays <d>` | no | Create DRAFT job; returns agent encryption key |
| `deliver` | `--index <n> --job <id>` | no (task gas) | 7702 upgrade + session grant + seal + POST session |
| `checkout` | `--job <id> [--client-agent <id>]` | no | Open the fee-escrow checkout |
| `escrow-fee` | `--checkout <id> [--yes]` | **YES** | approveEscrow + createOrder + confirm |
| `sweep` | `--index <n> [--to <addr>] [--yes]` | **YES** | **Term-end recovery**: send the task wallet's ERC-20 balances (U + tradables) then remaining BNB back to the login wallet |

`--yes` broadcasts; without it, `fund`/`escrow-fee`/`sweep` only preview.

## Stopping early — `revoke`, then `sweep`

There is no subcommand for it; the client marks the job revoked off-chain and
then takes the principal back, which is what actually ends the agent's ability
to trade (the granted session key only spends what is in the task wallet):

```bash
node scripts/aacp-api.mjs POST /api/v1/quant/jobs/<quantJobId>/revoke --auth session --body '{}'   # status → REVOKED (client only)
node scripts/quant-client.mjs sweep --index <n> --yes                                              # drain the task wallet
```

Say plainly that revoking mid-term does not undo trades already made and the
management fee already escrowed follows the normal order lifecycle. Reading
the platform's performance figures for a job: `GET /api/v1/quant/jobs/<id>/metrics`
(session; optional `?window=` / `?bucket=`).

## Recovery (`sweep`)

Run at **term end** (sweeping mid-term pulls the principal out from under the granted
session). `sweep` re-derives the task key (agentic sign) with the **address-match
guard**, then moves **token legs first, native BNB last** (each token transfer costs
gas, so draining native first would strand tokens). Default destination is the login
wallet; override with `--to`. Because derivation is deterministic, the task wallet is
always recoverable as long as the same agentic wallet can sign. On BSC prefer
`A2A_RPC_URL=https://bsc-dataseed.bnbchain.org` so receipts don't hang on the public node.

## Guards

- `fund`/`deliver` refuse until `derive --verify` reports `crossSession: PASS`.
- `deliver` re-derives and **refuses if the address ≠ the registered one** (your funds
  are at the registered address).
- The derived key is never written to disk or logged; local state
  (`.termix-quant-client-<chain>-<fp>.json`) holds only index/address/jobId.
- The dry-run boundary is `create`: everything up to it moves no money (skip `fund`).

## Dry-run (no money)

`login` → `client-strategy` → `allocate` → `register` → `create`. Produces a DRAFT job
and the agent encryption key without any transfer.

## Files

- `scripts/quant-task-wallet.mjs` — EIP-712 derivation message + HKDF→HDKey.
- `scripts/quant-client.mjs` — the subcommands, session seal, `grantSession`.
- Ports: `packages/frontend/lib/quant/{task-wallet,altana,envelope}.ts`,
  `app/quant/new/quant-new-page.tsx`.
