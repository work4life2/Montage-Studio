import type { RemoteConversation, RemoteMessage } from "./client.js";

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?/gi;

/** Image URLs the buyer put in a message (attachments come through as text too). */
export function imageUrlsIn(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(IMAGE_URL)].map((m) => m[0]);
}

function isOtherOrderEvent(m: RemoteMessage, orderId: string): boolean {
  return (m.kind === "ORDER_EVENT" || m.kind === "FUNDS_EVENT") && m.businessType === "order" && !!m.businessId && m.businessId !== orderId;
}

/**
 * A buyer's direct conversation with the agent spans every order they ever placed. For one order we
 * want the stretch that leads up to it: from the end of the previous order's events (or the start)
 * through the order's own events and anything said afterwards. `anchors` are the ids the platform
 * stamps on the order's events (the order id and the offer id it was created from).
 */
export function messagesForOrder(messages: RemoteMessage[], orderId: string, anchors: string[] = []): RemoteMessage[] {
  const ids = new Set([orderId, ...anchors.filter(Boolean)]);
  const anchor = messages.findIndex((m) => m.direction === "event" && !!m.businessId && ids.has(m.businessId));
  if (anchor < 0) {
    // Not an order we can locate: use everything after the last event of any other order.
    let start = 0;
    messages.forEach((m, i) => {
      if (isOtherOrderEvent(m, orderId)) start = i + 1;
    });
    return messages.slice(start);
  }
  let start = 0;
  for (let i = anchor - 1; i >= 0; i--) {
    if (isOtherOrderEvent(messages[i], orderId)) {
      start = i + 1;
      break;
    }
  }
  return messages.slice(start);
}

function sender(m: RemoteMessage): "buyer" | "agent" | "event" {
  if (m.direction === "in") return "buyer";
  if (m.direction === "out") return "agent";
  return "event";
}

/**
 * Turn conversation messages into brief text (chronological transcript) plus the buyer's reference
 * images. Our own replies are kept: they record what was promised (style, route, edition …).
 */
export function briefFromMessages(messages: RemoteMessage[]): { transcript: string; refs: string[]; buyerText: string[] } {
  const lines: string[] = [];
  const refs = new Set<string>();
  const buyerText: string[] = [];
  for (const m of messages) {
    const who = sender(m);
    const text = (m.text ?? "").trim();
    if (who === "event") {
      if (m.kind === "OFFER_EVENT" && m.metadata && typeof m.metadata.scope === "string" && m.metadata.event === "ISSUED") {
        lines.push(`[Quote sent: ${String(m.metadata.price ?? "")} ${String(m.metadata.currency ?? "")}, ${String(m.metadata.deliveryDays ?? "")} day(s)] scope: ${m.metadata.scope}`);
      }
      continue;
    }
    const urls = new Set<string>([...imageUrlsIn(text), ...(m.attachments ?? []).map((a) => a.url ?? "").filter(Boolean)]);
    if (who === "buyer") for (const u of urls) refs.add(u);
    if (m.kind === "ATTACHMENT" || (!text.replace(IMAGE_URL, "").trim() && urls.size)) {
      lines.push(`${who === "buyer" ? "Buyer" : "You"} sent image: ${[...urls].join(" ")}`);
      continue;
    }
    if (!text) continue;
    lines.push(`${who === "buyer" ? "Buyer" : "You"}: ${text}`);
    if (who === "buyer") buyerText.push(text);
  }
  return { transcript: lines.join("\n"), refs: [...refs], buyerText };
}

/** The buyer participant's identity strings (handle, display name, wallet, account id). */
export function buyerIdentity(conv: RemoteConversation): string[] {
  const out: string[] = [];
  for (const p of conv.participants ?? []) {
    if (p.role !== "BUYER" && p.role !== "MEMBER") continue;
    for (const v of [p.accountId, p.account?.handle, p.account?.displayName, p.account?.walletAddress]) if (v) out.push(String(v));
  }
  return out;
}

/** Quote status from the platform's own OFFER_EVENT rows (ISSUED → ACCEPTED / WITHDRAWN / EXPIRED …). */
export function offerStateFromMessages(messages: RemoteMessage[]): { offerId: string; status: string; price?: string; currency?: string; scope?: string; version?: number } | undefined {
  let last: { offerId: string; status: string; price?: string; currency?: string; scope?: string; version?: number } | undefined;
  for (const m of messages) {
    if (m.kind !== "OFFER_EVENT" || !m.businessId) continue;
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    const ev = String(md.event ?? "").toUpperCase();
    if (ev === "ISSUED" || ev === "REVISED") {
      last = { offerId: m.businessId, status: "active", price: md.price as string | undefined, currency: md.currency as string | undefined, scope: md.scope as string | undefined, version: md.version as number | undefined };
    } else if (last && last.offerId === m.businessId) {
      last = { ...last, status: ev.toLowerCase() || "closed" };
    }
  }
  return last;
}
