import type { Role } from "../config.js";
import type { Job } from "../jobs/store.js";

export interface PriceLine {
  item: string;
  usd: number;
}

export interface Priced {
  /** Price to charge, already rounded (USDC). */
  price: number;
  /** Our own cost estimate behind it (USD). */
  cost: number;
  lines: PriceLine[];
  deliveryDays: number;
}

export interface Deliverable {
  files: Array<{ file: string; contentType: string; label: string }>;
  /** On-chain delivery note (≤ 2000 chars). */
  note: string;
  /** Buyer-facing message posted in the conversation after delivery. */
  summary: string;
}

export interface ListingPackage {
  id: string;
  name: string;
  scope: string;
  /** Quote parameters this package stands for; its price is computed from them. */
  estimate: Record<string, unknown>;
  tone?: "accent" | "star";
}

export interface ListingSpec {
  title: string;
  skillTag: string;
  tags: string[];
  /** Description text; `{packages}` is replaced with the computed package price list. */
  description: string;
  packages: ListingPackage[];
  instantBuyable: boolean;
  /** false = packages only feed the price guide in the description (quote-only listing). */
  publishPackages?: boolean;
  coverAlt: string;
}

/**
 * One hosted agent: what it sells (listing), how it talks and quotes (persona + estimate),
 * how it prices (deterministic, cost-plus), and how it does the work.
 */
export interface RoleSpec<Spec = unknown> {
  role: Role;
  name: string;
  /** Who we are, what we can and cannot do — the chat system prompt is built from it. */
  persona: string;
  /** The JSON fields of the ESTIMATE the chat model emits when it quotes, with their meaning. */
  estimateFields: string;
  /** Cost-plus price for an estimate. `subtask`: hired by a prime (no platform fee on sub-tasks). */
  price(estimate: Record<string, unknown>, opts?: { subtask?: boolean }): Priced;
  /** Is the brief enough to start? If not, the question to ask before accepting the order. */
  assess(job: Job): Promise<{ ok: boolean; question?: string }>;
  /** Brief → structured work spec (shot list, song spec …). */
  plan(job: Job): Promise<Spec>;
  /** Do the work and return the files to deliver. */
  work(job: Job, spec: Spec): Promise<Deliverable>;
  /** Quote parameters a work spec corresponds to (prices sub-tasks offered by other agents). */
  estimateOf?(spec: Spec): Record<string, unknown>;
  listing: ListingSpec;
}
