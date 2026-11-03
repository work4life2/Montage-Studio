// ──────────────────────────────────────────────────────────
// Chain registry — which network this skill is talking to
// ──────────────────────────────────────────────────────────
//
// Termix runs the same marketplace on more than one chain. Each chain is a
// SEPARATE world: its own backend, its own accounts, agents, orders and stake.
// Nothing crosses over — an order id from one chain does not exist on the other.
//
// Pick one with AACP_CHAIN:
//
//   export AACP_CHAIN=base     # default: bsc — or rh (Robinhood Chain)
//
// That single variable resolves the API base, the JSON-RPC endpoint and the block
// explorer together, so they cannot drift apart. Setting the backend to one chain
// and the RPC to another is the failure this exists to prevent: every read would
// succeed against chain A while every broadcast went to chain B, and the only
// symptom would be aacp-tx.mjs refusing the intent on a chainId mismatch.
//
// Individual overrides still win, for self-hosted deployments and private nodes:
//
//   AACP_BASE_URL   overrides the API base
//   A2A_RPC_URL     overrides the JSON-RPC endpoint
//
// Contract addresses are NOT here. Always read them live from
// `GET /api/v1/config/contracts` on the selected chain — see docs/env.md.
//
// Zero dependencies, no side effects on import (house style for this skill).

// `quant` is a CAPABILITY, not a config toggle: it says whether the quant
// vertical can run on this chain at all. It is false for Base and Robinhood
// because the 7702 session that executes every quant trade goes through the
// Altana relay, and Altana has only `bnb-mainnet` / `bnb-testnet` — there is no
// Base or Robinhood network to execute against. An operator there could set the
// backend's quant env and the sessions still could not be executed, so this is
// not something configuration fixes. `true` means only "possible here", NOT
// "switched on": whether a given deployment actually has it is `quant !== null`
// in GET /api/v1/config/contracts, which aacp-quant.mjs checks separately
// against the live backend.
//
// Which chains the Binance Agentic Wallet can sign on is deliberately NOT
// recorded here: that list lives on Binance's side and grows over time, so
// aacp-wallet.mjs asks `baw wallet chains` at run time and refuses with the
// live list when the selected chainId is absent. Testnets never are.
export const CHAINS = {
  bsc: {
    slug: "bsc",
    label: "BNB Smart Chain",
    network: "BSC Mainnet",
    chainId: 56,
    apiBaseUrl: "https://platform-backend.prod.termix.live",
    // publicnode stopped serving eth_getTransactionReceipt without a token (2026-10).
    rpcUrl: "https://bsc-dataseed.bnbchain.org",
    explorer: "https://bscscan.com",
    nativeCurrency: "BNB",
    quant: true,
  },
  base: {
    slug: "base",
    label: "Base",
    network: "Base Mainnet",
    chainId: 8453,
    apiBaseUrl: "https://platform-backend-base.prod.termix.live",
    rpcUrl: "https://base-rpc.publicnode.com",
    explorer: "https://basescan.org",
    nativeCurrency: "ETH",
    quant: false,
  },
  // Robinhood Chain — an Arbitrum Orbit L2, gas in ETH. Public RPC on purpose:
  // the skill only sends/receipts/nonce/gas through it, never log filters.
  rh: {
    slug: "rh",
    label: "Robinhood",
    network: "Robinhood Mainnet",
    chainId: 4663,
    apiBaseUrl: "https://platform-backend-rh.prod.termix.live",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://explorer.mainnet.chain.robinhood.com",
    nativeCurrency: "ETH",
    quant: false,
  },
};

export const DEFAULT_CHAIN = "bsc";

/** Every selectable chain slug, for error messages and `print-env` output. */
export const CHAIN_SLUGS = Object.keys(CHAINS);

/**
 * The selected chain slug. An unknown AACP_CHAIN is a hard error rather than a
 * silent fallback: quietly running against BSC when the operator asked for Base
 * would spend real funds on the wrong network.
 */
export function activeChainSlug() {
  const raw = (process.env.AACP_CHAIN || "").trim().toLowerCase();
  if (!raw) return DEFAULT_CHAIN;
  if (!CHAINS[raw]) {
    throw new Error(
      `Unknown AACP_CHAIN "${process.env.AACP_CHAIN}" — expected one of: ${CHAIN_SLUGS.join(", ")}`,
    );
  }
  return raw;
}

export function activeChain() {
  return CHAINS[activeChainSlug()];
}

/** API base for the selected chain. `AACP_BASE_URL` overrides it. */
export function resolveApiBaseUrl() {
  const override = (process.env.AACP_BASE_URL || "").trim();
  return (override || activeChain().apiBaseUrl).replace(/\/+$/, "");
}

/** JSON-RPC endpoint for the selected chain. `A2A_RPC_URL` overrides it. */
export function resolveRpcUrl() {
  const override = (process.env.A2A_RPC_URL || "").trim();
  return (override || activeChain().rpcUrl).replace(/\/+$/, "");
}

/**
 * Refuse early when the selected chain cannot run the quant vertical at all.
 *
 * Called once at command dispatch in `aacp-quant.mjs`, so EVERY quant command
 * refuses the same way — including the API-only ones (`register-key`, `apply`,
 * `inbox`, `report`) that never resolve a router and so would otherwise sail
 * past the chain check and talk to a backend that has no quant to talk about.
 * Registering an encryption key on Base is the sharp edge: it succeeds, and
 * then no client can ever seal a session to it.
 */
export function assertQuantSupported() {
  const chain = activeChain();
  if (chain.quant) return chain;
  throw new Error(
    `The quant vertical does not run on ${chain.label} (AACP_CHAIN=${chain.slug}). Quant trades execute as ` +
      `EIP-7702 sessions through the Altana relay, which only has BNB Chain networks — there is no ${chain.label} ` +
      `network to execute against, so this is not something the operator can configure. ` +
      `Run quant commands with AACP_CHAIN=bsc, and note that ${chain.label} accounts, agents and orders are a ` +
      `separate marketplace: an agent id from here does not exist there.`,
  );
}

/** Block-explorer origin for the selected chain (no trailing slash). */
export function resolveExplorerUrl() {
  return activeChain().explorer.replace(/\/+$/, "");
}

/** Explorer link for a tx hash or address on the selected chain. */
export function explorerHref(value, kind = "tx") {
  const clean = String(value ?? "").trim();
  const base = resolveExplorerUrl();
  return clean ? `${base}/${kind}/${clean}` : base;
}

/**
 * A cwd cache file name scoped to the backend actually being talked to, e.g.
 * `.termix-a2a-session.base-3f21c8a9.env`.
 *
 * Every deployment is a SEPARATE database — not just bsc vs base vs rh, but dev
 * vs prod on each of them (six backends in total, plus any self-hosted override).
 * A session token minted by one is meaningless to the others, and a poll cursor
 * from one would silently skip work on another. Sharing one file across two of
 * them is not a small inefficiency, it is a wrong answer. Every on-disk token or
 * cursor this skill writes MUST go through here.
 *
 * The key is slug + a fingerprint of the RESOLVED api base, not the slug alone:
 * a dev bundle and a prod bundle carry the same slugs with different URLs baked
 * in, and `AACP_BASE_URL` can repoint either. Keying on the slug would let a dev
 * run and a prod run in the same directory quietly share a cursor.
 */
export function chainCacheFile(stem, extension) {
  return `${stem}.${activeChainSlug()}-${backendFingerprint()}${extension}`;
}

/**
 * 8 hex chars of FNV-1a over the resolved API base. Not a security boundary —
 * it only has to separate a handful of known hostnames from each other, and
 * doing it inline keeps this module import-free.
 */
function backendFingerprint() {
  let hash = 0x811c9dc5;
  for (const ch of resolveApiBaseUrl()) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** What the skill is currently pointed at — used by `print-env` and diagnostics. */
export function chainSummary() {
  const chain = activeChain();
  return {
    chain: chain.slug,
    network: chain.network,
    chainId: chain.chainId,
    quantSupported: Boolean(chain.quant),
    apiBaseUrl: resolveApiBaseUrl(),
    rpcUrl: resolveRpcUrl(),
    explorer: resolveExplorerUrl(),
    // Flag the overrides so a surprising endpoint is traceable to its source.
    apiBaseUrlOverridden: Boolean((process.env.AACP_BASE_URL || "").trim()),
    rpcUrlOverridden: Boolean((process.env.A2A_RPC_URL || "").trim()),
  };
}
