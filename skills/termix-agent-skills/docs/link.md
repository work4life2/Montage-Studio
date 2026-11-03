# Link this terminal to the user's web account

Most users meet Termix on the website first: they connect a browser wallet,
register an agent, and are then told to install this skill. That account — its
handle, its agents, its orders — lives on the website under **that** wallet.
Linking makes this terminal act **as that account**, so the agents they already
registered are the agents the skill works with. Nothing is duplicated and no
second wallet is involved.

**Lead with linking.** It needs no Binance wallet, no private key and no
`login`. The Binance Agentic Wallet (`wallet-login.md`) remains available as the
skill's *own* identity for users who want a separate one.

```bash
node scripts/aacp-link.mjs start
```

## What linking changes — and the one thing it does not

| | Linked | Skill's own wallet (agentic / key) |
|---|---|---|
| Priority | **1 — default whenever a link exists** | 2 (agentic) / 3 (key, explicit opt-in only) |
| Whose account | the user's **web** account | a separate account under the skill's wallet |
| Agents you see | the ones registered on the website | only ones minted from this terminal |
| Data shared with the web wallet | everything — same account | **nothing**; the two never exchange data or signatures |
| Off-chain REST calls | made as the web account (API key) | wallet session |
| **On-chain steps** | **the user signs in the browser with their web wallet** | the Binance wallet / `WALLET_KEY` signs here |
| Needs `baw` / Developer Mode | no | yes (agentic) |

The one thing linking never does is sign. Every on-chain step still runs
through `scripts/aacp-tx.mjs`, which in linked mode creates a **signature
request** on the website, opens the sign page in the browser, and waits until
the user has signed there. See [`onchain-tx.md`](onchain-tx.md#linked-mode).

## The walkthrough to drive with the user

### 1. Start the link — on the chain the user named

The website hands the user a phrase that names the chain: **"link this
terminal to my Termix account on BSC / Base / Robinhood"**. That word picks
the backend, because each chain is linked separately (see Boundaries). Map it
to `AACP_CHAIN` for this run and say which chain you are linking:

| The user says "… on" | Run |
|---|---|
| BSC / BNB Chain / 币安链 | `AACP_CHAIN=bsc node scripts/aacp-link.mjs start` (the default) |
| Base | `AACP_CHAIN=base node scripts/aacp-link.mjs start` |
| Robinhood / RH | `AACP_CHAIN=rh node scripts/aacp-link.mjs start` |

If the phrase names no chain, ask which one before starting (SKILL.md rule 9)
rather than linking the default and leaving a Base or Robinhood user with a
key their site never shows. A user who works on more than one chain repeats
the link once per chain; the stored files are per chain and do not collide.

```bash
node scripts/aacp-link.mjs start
```

It prints a **code** and a page URL, opens the page in the browser (`xdg-open`
/ `open` / `start`; if that fails it says so — the URL works from any device,
including a phone), then **blocks**, printing a "still waiting…" line every
~10 s with the code repeated. The code expires in about 10 minutes.

Tell the user, in this order: sign in on that page **with the wallet they
registered with**, check that the code on the page matches the one printed
here, pick how long the link should last (the site offers 7 / 30 / 90 days or
never), and approve.

On approval the terminal receives an API key for the account and stores it in
`.termix-link.<chain>-<backend>.env` (mode 0600, current directory). **Never
print the key.** Report only the handle and wallet the output names, then offer
the `nextSteps` it returns as a numbered menu.

### 2. Confirm, then carry on as usual

```bash
node scripts/aacp-link.mjs status      # linked? to whom? still accepted?
node scripts/a2a-runtime.mjs agents    # the agents registered on the website
node scripts/aacp-next.mjs             # what the user can do from here
```

Everything else in this skill is unchanged: `aacp-api.mjs --auth session`,
`aacp-watch.mjs wait`, `a2a-runtime.mjs token|autoreply`, the client and
provider workflows. They all read the link automatically. `login` is not
needed and says so if run.

### 3. When an action needs a signature

`aacp-tx.mjs` prints the sign-page URL, opens it, and waits — up to 15 minutes.
Tell the user to sign there with their web wallet. The request also appears
under the **pending-signatures badge** in the website header, so a user who
missed the tab can find it later. On success the script returns the same
`results[{action, txHash, status}]` as every other mode and the workflow
continues (confirm endpoints, polling) exactly as documented.

## Boundaries — say these plainly, do not soften them

- **Every on-chain step needs the user in a browser.** A hosting loop that hits
  one will stop and wait for the signature; after 15 minutes without one the
  request expires and the step must be re-run. Unattended `autoreply` never
  signs, so it is unaffected.
- **The key is the account.** It can do anything the user can do on the site,
  except manage keys. It expires when the user chose, and can be revoked at any
  time under **Account → Connected terminals**. Keep it local; never paste it.
- **The skill's own wallet keeps its own account.** Agents minted or points
  earned under the Binance wallet stay there; linking does not merge them.
  `aacp-link.mjs identity agentic` switches back to that identity at any time.
- **Each chain is linked separately.** BSC, Base and Robinhood are separate
  backends; a link made on one does not exist on the others (`aacp-link.mjs
  status` under `AACP_CHAIN=base` or `AACP_CHAIN=rh` says so).
- **The sign page checks the wallet.** If the browser is connected to a wallet
  other than the one that owns the account, the page refuses and asks the user
  to switch.

## Stages and their cures

| What you see | What it means | What to do |
|---|---|---|
| `aacp-next.mjs` → `stage: link-expired` | The key expired, or was revoked on the website | `aacp-link.mjs start` again (or `identity agentic` to use the skill's wallet) |
| Any script: "The web-account link is expired or revoked" | same | same |
| `aacp-link.mjs start` → "denied on the website" | The user pressed Deny | Nothing stored; ask before trying again |
| `aacp-link.mjs start` → "code expired" | Nobody approved within ~10 minutes | Run `start` again for a fresh code |
| `aacp-tx.mjs` → "declined … in the browser" | The user rejected the wallet prompt | Do not retry unasked |
| `aacp-tx.mjs` → "Nobody signed within 15 minutes" | The request expired | Re-run the same command when the user is ready |
| `a2a-runtime.mjs token` → "not owned by the linked web account" | The agent belongs to another account | `a2a-runtime.mjs agents` lists the owned ones |

## Commands

```bash
node scripts/aacp-link.mjs start [--label "<device label>"] [--force]   # link (or re-link) this chain
node scripts/aacp-link.mjs status [--offline]                          # who, until when, still accepted?
node scripts/aacp-link.mjs identity [linked|agentic]                   # show / switch the active identity
node scripts/aacp-link.mjs unlink                                      # forget the key here
```

`unlink` removes the local file. Revoking the key for good is done on the
website (the terminal deliberately cannot manage keys); `unlink` says so.

`--label` names this terminal on the approval page (default `user@host`).
`TERMIX_API_KEY` in the environment overrides the stored key — for CI, never for
a human's shell.

## Recovery and revocation

- `start` checks a stored key online before deciding it is already linked. A revoked or server-expired key starts a new authorization automatically.
- Runtime caches are bound to the active credential. Rebinding or changing identity invalidates the old cache; restart hosting after switching accounts.
- New linked runtime tokens are checked against their issuing API key on every request. Revocation stops the next runtime call. Tokens issued before this update can remain valid for up to 12 hours; restart old linked workers during rollout.
- If only some transactions were sent before cancellation or failure, inspect the reported hashes before retrying. The browser keeps a local hash journal and resumes reporting/confirmation without resending those transactions.
