import { getConfig, ROLES, type Role } from "../config.js";
import { logger } from "../log.js";
import { formatBreakdown } from "../pricing.js";
import { chat, type ChatMessage } from "../relay.js";
import { roleSpec } from "../roles/index.js";
import type { Priced } from "../roles/types.js";
import { termix, type RemoteConversation, type RemoteMessage, type WatchEvent } from "../termix/client.js";
import { briefFromMessages, imageUrlsIn, messagesForOrder, offerStateFromMessages } from "../termix/brief.js";
import { isChinese } from "../util/lang.js";
import { findJobByOrder, loadConversation, saveConversation, type ConversationLog, type OfferRecord } from "./store.js";

const log = logger("chat");

/** The machine-readable quote request the chat model appends when it decides to quote. */
const QUOTE_LINE = /^\s*QUOTE:\s*(\{[\s\S]*\})\s*$/m;

export interface ParsedQuote {
  estimate: Record<string, unknown>;
  scope: string;
  deliveryDays?: number;
}

export function parseQuoteReply(reply: string): { text: string; quote?: ParsedQuote } {
  const m = QUOTE_LINE.exec(reply);
  if (!m) return { text: reply.trim() };
  const text = reply.replace(m[0], "").trim();
  try {
    const raw = JSON.parse(m[1]) as Record<string, unknown>;
    const scope = String(raw.scope ?? "").trim();
    const estimate = (raw.estimate ?? {}) as Record<string, unknown>;
    if (scope.length < 10 || typeof estimate !== "object") return { text };
    const days = Math.round(Number(raw.deliveryDays));
    return { text, quote: { estimate, scope: scope.slice(0, 6000), deliveryDays: Number.isFinite(days) && days > 0 && days <= 60 ? days : undefined } };
  } catch {
    return { text };
  }
}

/** Studio agents never sell to each other through chat: their threads carry sub-task briefs, handled by the workers. */
export function studioCounterpart(role: Role, conv: RemoteConversation | undefined): Role | undefined {
  const agents = getConfig().agents;
  for (const p of conv?.participants ?? []) {
    const id = p.agentId ?? undefined;
    const other = ROLES.find((r) => r !== role && agents[r].agentId === id);
    if (other) return other;
  }
  return undefined;
}

function historyLines(remote: RemoteMessage[] | undefined, conv: ConversationLog): string {
  if (remote?.length) {
    const recent = remote.filter((m) => m.direction !== "event" || m.kind === "OFFER_EVENT").slice(-20);
    return briefFromMessages(recent).transcript;
  }
  return conv.messages
    .slice(-14)
    .map((m) => `${m.role === "buyer" ? "Buyer" : "You"}: ${m.text}`)
    .join("\n");
}

async function fetchImages(urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls.slice(-2)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) out.push(`data:${res.headers.get("content-type") ?? "image/png"};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function chatSystemPrompt(role: Role): string {
  const spec = roleSpec(role);
  const { currency } = getConfig();
  const packages = spec.listing.packages.map((p) => `- ${p.name}: ${p.scope} (${spec.price(p.estimate).price} ${currency})`).join("\n");
  return `${spec.persona}

You are chatting with a prospective or current buyer on Termix. Rules:
- Reply in the buyer's language (Chinese if they write Chinese, else English). Be concise and concrete: 2–6 sentences, no fluff, no markdown headings.
- Only promise what is listed above. If they need something outside your scope, say so plainly and point them to the right studio agent: Montage Studio (finished music videos / ads — script, storyboard, song, renders and edit in one order), Sketchboard (storyboards & keyframes), Beatsmith (songs and instrumentals, Google Lyria 3 / ElevenLabs Music), RenderFarm (video renders on Runway).
- Never state a price or a total yourself, never do arithmetic on prices. Prices are computed by the system from your estimate.
- When you know enough to price the work, end your reply with ONE line exactly like:
  QUOTE: {"estimate": ${spec.estimateFields}, "scope": "the consolidated brief in English: deliverables, quantities, style, format, everything agreed so far — the buyer accepts this text as the order scope", "deliveryDays": optional integer}
  The system turns it into a formal quote the buyer can accept and fund in this chat, and appends the price to your message. Do not mention the QUOTE line.
- If a detail that changes the price is missing, make a sensible assumption, say it in one sentence, and quote anyway (the quote can be revised). Ask at most one question per reply.
- A buyer who opened a "Custom" request wants a PRICE: quote in your first reply.
- If an active quote already exists and nothing changed, do not quote again.

Current packages on your listing (for reference — quote custom work with QUOTE):
${packages}`;
}

function quoteNotice(rec: OfferRecord, zh: boolean, revised: boolean): string {
  if (zh) {
    return revised
      ? `📄 报价已更新：${rec.price} ${rec.currency}，${rec.deliveryDays} 天内交付。请在本会话中接受最新报价并付款，付款后立即开工。`
      : `📄 报价：${rec.price} ${rec.currency}，${rec.deliveryDays} 天内交付（范围见报价卡）。在本会话中接受并付款后立即开工。`;
  }
  return revised
    ? `📄 Quote updated: ${rec.price} ${rec.currency}, delivery within ${rec.deliveryDays} day(s). Accept the latest quote in this chat and fund it; work starts right after payment.`
    : `📄 Quote: ${rec.price} ${rec.currency}, delivery within ${rec.deliveryDays} day(s) (scope on the quote card). Accept it in this chat and fund the escrow, and work starts right away.`;
}

/** Send (or revise) a quote whose price is computed from the estimate, cost-plus. */
async function placeQuote(role: Role, conv: ConversationLog, q: ParsedQuote, remote: RemoteMessage[] | undefined): Promise<{ record: OfferRecord; revised: boolean; priced: Priced }> {
  const spec = roleSpec(role);
  const { currency } = getConfig();
  const t = termix(role);
  const priced = spec.price(q.estimate);
  const deliveryDays = Math.max(priced.deliveryDays, q.deliveryDays ?? 0);
  const price = priced.price.toFixed(2).replace(/\.?0+$/, "");
  const local = conv.offers?.filter((o) => o.status === "active").at(-1);
  const remoteState = remote ? offerStateFromMessages(remote) : undefined;
  const activeId = remoteState?.status === "active" ? remoteState.offerId : local && remoteState?.offerId === local.offerId && remoteState.status !== "active" ? undefined : local?.offerId;
  const input = { price, currency, deliveryDays, scope: q.scope, message: `Priced from the scope above (${spec.name}).` };
  let revised = false;
  let res;
  if (activeId) {
    try {
      res = await t.reviseOffer(activeId, input);
      revised = true;
    } catch (err) {
      log.warn(`${role}: revise offer ${activeId} failed (${String(err).slice(0, 200)}); sending a fresh quote`);
    }
  }
  if (!res) res = await t.sendOffer(conv.id, input);
  conv.offers ??= [];
  for (const o of conv.offers) if (o.status === "active" && o.offerId !== res.id) o.status = "superseded";
  const record: OfferRecord = {
    offerId: res.id,
    revisionId: res.current?.id ?? res.currentRevisionId,
    version: res.current?.version,
    price,
    currency,
    deliveryDays,
    scope: q.scope,
    at: new Date().toISOString(),
    status: "active",
    estimate: q.estimate,
    breakdown: priced.lines,
  };
  conv.offers = [...conv.offers.filter((o) => o.offerId !== res.id), record];
  return { record, revised, priced };
}

/** Answer a buyer message with the chat model; quote when it emits a QUOTE line. */
export async function handleChatMessage(role: Role, ev: WatchEvent, hooks: { onBuyerReply?: (conversationId: string) => void } = {}): Promise<void> {
  const conversationId = ev.conversationId;
  const text = (ev.text ?? "").trim();
  if (!conversationId) return;
  const t = termix(role);
  const remoteConv = await t.conversation(conversationId);
  if (remoteConv?.kind === "ORDER_TEAM") return; // team channel: read by the production / sub-task workers
  if (studioCounterpart(role, remoteConv)) return; // internal brief thread between our own agents
  const requested = typeof ev.requestedScope === "string" ? ev.requestedScope : "";
  if (!text && !requested) return;
  const conv = loadConversation(role, conversationId);
  if (ev.messageId && conv.messages.some((m) => m.messageId === ev.messageId)) return;
  if (ev.orderId) conv.orderId = String(ev.orderId);
  const from = ev.from;
  conv.buyer = typeof from === "string" ? from : (from?.displayName ?? from?.handle ?? "buyer");
  const refs = imageUrlsIn(text);
  conv.messages.push({ role: "buyer", text: text || `[Custom quote request] ${requested}`, at: new Date().toISOString(), messageId: ev.messageId, from: conv.buyer, refs: refs.length ? refs : undefined });
  saveConversation(role, conv);

  await t.signal(conversationId);
  const keepAlive = setInterval(() => void t.signal(conversationId), 30_000);
  try {
    const remote = remoteConv?.messages;
    const context: string[] = [`Buyer: ${conv.buyer}.`];
    if (ev.businessType === "listing_quote_request") {
      const tier = ev.referenceTier as { name?: string; price?: string | number } | null | undefined;
      context.push(`They opened a CUSTOM QUOTE request from your listing${tier?.name ? ` (starting from the "${tier.name}" package)` : ""}. Requested scope: ${requested || text}. Quote now.`);
    }
    const orderId = conv.orderId;
    if (orderId) {
      const job = findJobByOrder(role, orderId);
      context.push(job ? `This conversation belongs to order ${orderId}. Job status: ${job.status}${job.error ? ` (last error: ${job.error.slice(0, 200)})` : ""}.` : `This conversation belongs to order ${orderId}; work starts automatically once it is funded and accepted.`);
    }
    const remoteState = remote ? offerStateFromMessages(remote) : undefined;
    const activeLocal = conv.offers?.filter((o) => o.status === "active").at(-1);
    if (remoteState?.status === "active" || activeLocal) {
      const o = remoteState?.status === "active" ? remoteState : activeLocal!;
      context.push(`An ACTIVE quote exists in this conversation: ${o.price} ${o.currency ?? ""}${o.scope ? ` — scope: ${String(o.scope).slice(0, 500)}` : ""}. Emit QUOTE again only if the scope changes (it becomes a revision).`);
    } else if (remoteState) {
      context.push(`The previous quote in this conversation is ${remoteState.status}. A new brief needs a new QUOTE.`);
    }
    const history = historyLines(remote, conv);
    const window = remote && orderId ? messagesForOrder(remote, orderId) : remote;
    const recentRefs = refs.length ? refs : window ? briefFromMessages(window.slice(-10)).refs : [];
    const images = await fetchImages(recentRefs);
    const userContent: ChatMessage["content"] = [
      { type: "text", text: `Context:\n${context.join("\n")}\n\nConversation so far (chronological; "You" is us):\n${history}\n\nWrite your next reply to the buyer (reply text only). If you are quoting, end with the single QUOTE line.` },
      ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ];
    const raw = await chat([{ role: "system", content: chatSystemPrompt(role) }, { role: "user", content: userContent }], { tag: `chat:${role}`, maxTokens: 3000 });
    const zh = isChinese(text || requested) || isChinese(history);
    let { text: reply, quote } = parseQuoteReply(raw);
    if (!reply && !quote) reply = zh ? "收到，马上处理。" : "Got it — on it.";
    if (quote) {
      try {
        const { record, revised, priced } = await placeQuote(role, conv, quote, remote);
        reply = `${reply}\n\n${quoteNotice(record, zh, revised)}`.trim();
        log.info(`${role}: quote ${revised ? "revised" : "sent"} in ${conversationId}`, { offerId: record.offerId, price: record.price, estimate: quote.estimate, basis: formatBreakdown(priced, record.currency) });
      } catch (err) {
        log.error(`${role}: could not send quote in ${conversationId}: ${String(err)}`);
        reply = `${reply}\n\n${zh ? "（报价暂时发送失败，请稍后再试或直接购买 listing 套餐。）" : "(The quote could not be sent right now — please try again shortly, or buy a listing package directly.)"}`.trim();
      }
    }
    await t.reply(conversationId, reply, ev.messageId ? `auto-${ev.messageId}` : undefined);
    conv.messages.push({ role: "agent", text: reply, at: new Date().toISOString() });
    saveConversation(role, conv);
    log.info(`${role}: replied in ${conversationId}`, { chars: reply.length, quoted: Boolean(quote) });
    hooks.onBuyerReply?.(conversationId);
  } finally {
    clearInterval(keepAlive);
  }
}

/** Post a plain notice into a conversation, without the model. */
export async function postNotice(role: Role, conversationId: string, text: string): Promise<void> {
  const conv = loadConversation(role, conversationId);
  await termix(role).reply(conversationId, text);
  conv.messages.push({ role: "agent", text, at: new Date().toISOString() });
  saveConversation(role, conv);
}
