import { getConfig, type Role } from "./config.js";
import type { PriceLine, Priced } from "./roles/types.js";

/** Round a price up to a tidy step (0.1 below 10, 0.5 below 100, 1 above). */
export function tidy(price: number): number {
  const step = price < 10 ? 0.1 : price < 100 ? 0.5 : 1;
  return Math.round(Math.ceil(price / step - 1e-9) * step * 100) / 100;
}

/** Smallest price any listing or quote goes out at. */
export const MIN_PRICE = 1;

/**
 * Cost-plus: price = (1 + margin) × (cost + platform fee). The 2% protocol fee is charged on
 * buyer orders only (sub-tasks carry none), and it is part of the cost, so it is grossed up:
 * price = (1+m)·base / (1 − (1+m)·fee).
 */
export function costPlus(role: Role, lines: PriceLine[], deliveryDays: number, opts: { subtask?: boolean } = {}): Priced {
  const { pricing } = getConfig();
  const m = pricing.margin[role];
  const base = lines.reduce((s, l) => s + l.usd, 0);
  const fee = opts.subtask ? 0 : pricing.platformFee;
  const raw = ((1 + m) * base) / (1 - (1 + m) * fee);
  const price = Math.max(MIN_PRICE, tidy(raw));
  const out: PriceLine[] = lines.map((l) => ({ item: l.item, usd: Math.round(l.usd * 1000) / 1000 }));
  if (fee) out.push({ item: `platform fee ${fee * 100}%`, usd: Math.round(price * fee * 1000) / 1000 });
  return { price, cost: Math.round((base + price * fee) * 1000) / 1000, lines: out, deliveryDays };
}

export const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const gasLine = (txs: number): PriceLine => ({ item: `on-chain gas (${txs} tx)`, usd: txs * getConfig().pricing.gasUsdPerTx });

/** Rough LLM spend for planning/chat on the relay (Claude Sonnet class: ~$3/M in, ~$15/M out). */
export const llmLine = (item: string, inTokens: number, outTokens: number): PriceLine => ({ item, usd: (inTokens * 3 + outTokens * 15) / 1e6 });

export function formatBreakdown(p: Priced, currency: string): string {
  const parts = p.lines.map((l) => `${l.item} ≈ $${l.usd.toFixed(2)}`);
  return `${parts.join("; ")}. Cost ≈ $${p.cost.toFixed(2)} → price ${p.price} ${currency}.`;
}
