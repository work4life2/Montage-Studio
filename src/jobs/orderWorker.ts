import fs from "node:fs";
import path from "node:path";
import { getConfig, type Role } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type RemoteConversation, type TxIntent } from "../termix/client.js";
import { briefFromMessages, buyerIdentity, messagesForOrder } from "../termix/brief.js";
import { roleSpec } from "../roles/index.js";
import type { Deliverable } from "../roles/types.js";
import { createJob, findJobByOrder, findOfferRecord, loadConversation, saveJob, type Job } from "./store.js";
import { postNotice } from "./chat.js";

export interface Order {
  id: string;
  status: string;
  redoUsed?: boolean;
  deliveryDueAt?: string;
  challengeWindowEndsAt?: string;
  availableActions?: Record<string, boolean>;
  conversationId?: string;
  offerId?: string;
  fundingSource?: string;
  split?: { role?: string; claimableAmount?: string; claimBlocker?: string | null; nothingToClaim?: boolean; teamConversationId?: string | null; [k: string]: unknown } | null;
  [k: string]: unknown;
}

const BRIEF_KEYS = new Set([
  "note", "brief", "requirements", "requirement", "scope", "description", "title", "message", "packageName", "package", "addons",
  "redoNote", "redoReason", "instructions", "details", "spec", "summary", "clientNote", "buyerNote",
]);
/** Sub-objects of the order payload that describe us or the platform, not the buyer's wishes. */
const NOT_BRIEF_KEYS = /^(buyer|client|provider|seller|wallet|tx|signature|callData|listing|partyCards|providerAgent|clientAgent|checkout|timeline|txIntents|artifacts|review|dispute|deadlines|nextAction|availableActions|split)$/i;
const NOT_REF_KEYS = /^(avatarUrl|coverImageUrl|imageUrl|logo|icon|previewUrl|thumbnail)$/i;

/** Collect every plausible brief field from the order payload (shape is backend-defined). */
export function extractBrief(order: Record<string, unknown>): { text: string; refs: string[] } {
  const lines: string[] = [];
  const refs = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, keyPath: string, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") {
      const last = keyPath.split(".").pop() ?? "";
      if (/^https?:\/\/\S+\.(png|jpe?g|webp)(\?\S*)?$/i.test(v.trim()) && !NOT_REF_KEYS.test(last)) refs.add(v.trim());
      if (BRIEF_KEYS.has(last) && v.trim() && !/^(0x[0-9a-f]{40}|c[a-z0-9]{20,})$/i.test(v)) lines.push(`${keyPath}: ${v.trim()}`);
      return;
    }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${keyPath}[${i}]`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (NOT_BRIEF_KEYS.test(k)) continue;
      walk(x, keyPath ? `${keyPath}.${k}` : k, depth + 1);
    }
  };
  walk(order, "", 0);
  return { text: [...new Set(lines)].join("\n"), refs: [...refs] };
}

/** Is this order sold by the given agent? Orders of anyone else are none of its business. */
export function ownsOrder(role: Role, order: Order): boolean {
  const agentId = getConfig().agents[role].agentId;
  const seller = (order.seller ?? order.providerAgent ?? {}) as { id?: string; agentId?: string; agentTokenId?: string | number };
  const candidates = [seller.id, seller.agentId, order.providerAgentId, order.sellerAgentId].filter(Boolean).map(String);
  return candidates.includes(agentId);
}

/** A child order created by a sub-task (we are the assignee, the prime is the buyer). */
export function isChildOrder(order: Order): boolean {
  return order.fundingSource === "SPLIT" || order.split?.role === "assignee";
}

function orderConversationId(order: Order): string | undefined {
  const c = order.conversationId ?? (order.conversation as { id?: string } | undefined)?.id;
  return typeof c === "string" ? c : undefined;
}

function buyerIds(order: Order): string[] {
  const b = (order.buyer ?? {}) as { id?: string; walletAddress?: string; handle?: string; displayName?: string; clientAgentId?: string };
  return [b.id, b.walletAddress, b.handle, b.displayName, b.clientAgentId].filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** The conversation an order was negotiated in (offer thread, else the order's own, else the latest DM with the buyer). */
export async function resolveOrderConversation(role: Role, order: Order): Promise<{ id?: string; conv?: RemoteConversation }> {
  const tx = termix(role);
  const own = orderConversationId(order);
  const fromOffer = (order.offer as { conversationId?: string } | undefined)?.conversationId;
  const candidates = [fromOffer, own].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (!candidates.length && typeof order.offerId === "string") {
    const offer = await tx.offer(order.offerId);
    if (offer?.conversationId) candidates.push(offer.conversationId);
  }
  if (!candidates.length) {
    const ids = new Set(buyerIds(order));
    if (ids.size) {
      try {
        const all = (await tx.conversations())
          .filter((c) => (c.kind ?? "DIRECT_MESSAGE") === "DIRECT_MESSAGE" && buyerIdentity(c).some((x) => ids.has(x)))
          .sort((a, b) => String(b.updatedAt ?? b.lastMessage?.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.lastMessage?.createdAt ?? "")));
        if (all[0]) candidates.push(all[0].id);
      } catch (err) {
        tx.log.warn(`order ${order.id}: could not list conversations — ${String(err)}`);
      }
    }
  }
  for (const id of candidates) {
    const conv = await tx.conversation(id);
    if (conv) return { id, conv };
  }
  return { id: candidates[0] ?? own };
}

/** Order/offer scope + the conversation that led to the order (buyer messages, our replies, their images). */
export async function composeBrief(role: Role, order: Order): Promise<{ brief: string; refs: string[]; conversationId?: string }> {
  const { text, refs } = extractBrief(order as Record<string, unknown>);
  const { id: conversationId, conv } = await resolveOrderConversation(role, order);
  let brief = text;
  const allRefs = new Set<string>();
  const offerId = typeof order.offerId === "string" ? order.offerId : undefined;
  if (conv?.messages?.length) {
    const window = messagesForOrder(conv.messages, order.id, offerId ? [offerId] : []);
    const { transcript, refs: convRefs } = briefFromMessages(window);
    if (transcript.trim()) brief += `\n\nConversation with the buyer that led to this order (chronological; "You" is us — everything agreed here is part of the brief):\n${transcript}`;
    for (const r of convRefs) allRefs.add(r);
  } else if (conversationId) {
    const local = loadConversation(role, conversationId);
    const buyerLines = local.messages.filter((m) => m.role === "buyer").map((m) => m.text);
    if (buyerLines.length) brief += `\n\nBuyer messages in the order conversation:\n${buyerLines.join("\n")}`;
    for (const m of local.messages) for (const r of m.refs ?? []) allRefs.add(r);
  }
  if (!allRefs.size) for (const r of refs) allRefs.add(r);
  return { brief, refs: [...allRefs], conversationId };
}

/** Quote parameters behind an order: our own offer record, else the listing package it was bought from. */
function estimateFor(role: Role, order: Order, brief: string): Record<string, unknown> | undefined {
  if (typeof order.offerId === "string") {
    const rec = findOfferRecord(role, order.offerId);
    if (rec?.estimate) return rec.estimate;
  }
  const spec = roleSpec(role);
  const m = /Package:\s*(.+)/.exec(brief);
  const pkg = m ? spec.listing.packages.find((p) => p.name.trim().toLowerCase() === m[1].trim().toLowerCase()) : undefined;
  if (pkg) return pkg.estimate;
  const budget = Number(order.budget ?? order.amount ?? order.price);
  if (Number.isFinite(budget)) {
    const hit = spec.listing.packages.find((p) => Math.abs(spec.price(p.estimate).price - budget) < 0.01);
    if (hit) return hit.estimate;
  }
  return undefined;
}

export async function getOrder(role: Role, orderId: string): Promise<Order> {
  const res = await termix(role).get<Order | { order: Order }>(`/api/v1/orders/${orderId}`);
  return "order" in (res as object) && (res as { order: Order }).order ? (res as { order: Order }).order : (res as Order);
}

export async function pollOrder(role: Role, orderId: string, until: (o: Order) => boolean, timeoutMs = 10 * 60_000): Promise<Order> {
  const end = Date.now() + timeoutMs;
  let last = await getOrder(role, orderId);
  while (!until(last) && Date.now() < end) {
    await sleep(8000);
    last = await getOrder(role, orderId);
  }
  return last;
}

export function intentFrom(res: unknown): TxIntent {
  const r = res as Record<string, unknown>;
  const candidate = (r.txIntent ?? r.intent ?? r.transaction ?? r) as TxIntent;
  if (!candidate.callData && !candidate.data) throw new Error(`no tx-intent in response: ${JSON.stringify(res).slice(0, 300)}`);
  return candidate;
}

async function acceptOrder(job: Job, order: Order): Promise<Order> {
  if (order.status !== "PENDING_ACCEPT") return order;
  const t = termix(job.role);
  job.status = "accepting";
  saveJob(job);
  t.log.info(`order ${order.id}: accepting on-chain`);
  const prep = await t.api("POST", `/api/v1/orders/${order.id}/provider-accept/prepare`, {});
  const tx = await t.tx(intentFrom(prep), { orderId: order.id });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes.acceptOrder = hash;
  saveJob(job);
  const o = await pollOrder(job.role, order.id, (x) => x.status === "FUNDED" || x.status === "IN_PROGRESS");
  if (o.status !== "FUNDED" && o.status !== "IN_PROGRESS") throw new Error(`order ${order.id} did not reach FUNDED/IN_PROGRESS after accept (status ${o.status})`);
  return o;
}

async function uploadArtifact(job: Job, file: string, contentType: string, label: string): Promise<string> {
  const t = termix(job.role);
  const sizeBytes = fs.statSync(file).size;
  const up = await t.api<{ uploadUrl: string; s3Key?: string; publicUrl?: string; url?: string; key?: string }>("POST", `/api/v1/orders/${job.orderId}/delivery/upload-url`, {
    fileName: label,
    contentType,
    sizeBytes,
  });
  const uploaded = await t.upload(up.uploadUrl, file, contentType);
  const reg = await t.api<{ id?: string; artifactId?: string; artifact?: { id: string } }>("POST", `/api/v1/orders/${job.orderId}/delivery/artifacts`, {
    s3Key: up.s3Key ?? up.key,
    url: up.publicUrl ?? up.url,
    sha256: uploaded.sha256,
    contentType,
    sizeBytes,
  });
  const artifactId = reg.id ?? reg.artifactId ?? reg.artifact?.id;
  if (!artifactId) throw new Error(`artifact registration returned no id: ${JSON.stringify(reg).slice(0, 300)}`);
  job.artifacts.push({ name: label, file, contentType, sizeBytes, sha256: uploaded.sha256, artifactId, url: up.publicUrl ?? up.url });
  saveJob(job);
  t.log.info(`order ${job.orderId}: uploaded ${label} (${(sizeBytes / 1e6).toFixed(1)} MB)`);
  return artifactId;
}

/** Upload every deliverable, submit the delivery on-chain and wait for DELIVERED. */
export async function deliver(job: Job, d: Deliverable): Promise<void> {
  const t = termix(job.role);
  job.status = "delivering";
  job.artifacts = [];
  saveJob(job);
  const ids: string[] = [];
  for (const f of d.files) ids.push(await uploadArtifact(job, f.file, f.contentType, f.label));
  const note = d.note.length > 1990 ? d.note.slice(0, 1989) + "…" : d.note;
  const submit = await t.api("POST", `/api/v1/orders/${job.orderId}/delivery/submit`, { artifactIds: ids, note });
  const tx = await t.tx(intentFrom(submit), { orderId: job.orderId });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes[job.redoRound ? `submitDelivery-redo${job.redoRound}` : "submitDelivery"] = hash;
  saveJob(job);
  const o = await pollOrder(job.role, job.orderId, (x) => x.status === "DELIVERED");
  if (o.status !== "DELIVERED") throw new Error(`order ${job.orderId} not DELIVERED after submit (status ${o.status})`);
  job.status = "delivered";
  saveJob(job);
}

/** Orders the service must never accept (operator decision). */
const EXCLUDED_ORDERS = new Set<string>();

const skipped = (role: Role, orderId: string, note: string) =>
  ({ id: `skipped-${orderId}`, role, kind: "order", orderId, status: "failed", brief: "", refs: [], createdAt: "", updatedAt: "", attempts: 0, redoRound: 0, dir: "", artifacts: [], txHashes: {}, notes: [note] }) as Job;

/**
 * Full lifecycle for one funded buyer order: brief → (ask if unworkable) → accept → plan → work → deliver.
 * Idempotent: re-running resumes from the persisted job state.
 */
export async function processOrder(role: Role, orderId: string, opts: { redoNote?: string } = {}): Promise<Job> {
  const t = termix(role);
  if (EXCLUDED_ORDERS.has(orderId)) return skipped(role, orderId, "excluded by the operator");
  let order = await getOrder(role, orderId);
  if (!ownsOrder(role, order) || isChildOrder(order)) return skipped(role, orderId, "not a buyer order of this agent");
  const spec = roleSpec(role);
  let job = findJobByOrder(role, orderId);
  if (!job) {
    const composed = await composeBrief(role, order);
    job = createJob({
      role,
      kind: "order",
      id: `order-${orderId}`,
      orderId,
      brief: composed.brief,
      refs: composed.refs,
      conversationId: composed.conversationId,
      estimate: estimateFor(role, order, composed.brief),
    });
    t.log.info(`order ${orderId}: job created`, { refs: composed.refs.length, conversation: composed.conversationId ?? null, briefChars: composed.brief.length, estimate: job.estimate ?? null });
  } else if (job.status === "awaiting_input" || job.status === "queued") {
    // The buyer may have answered our question since: rebuild the brief from the conversation.
    const composed = await composeBrief(role, order);
    job.brief = composed.brief;
    if (composed.refs.length) job.refs = composed.refs;
    job.conversationId ??= composed.conversationId;
    saveJob(job);
  }
  try {
    if ((opts.redoNote || order.redoUsed) && job.status === "delivered") {
      job.redoRound += 1;
      job.status = "queued";
      job.notes.push(`redo ${job.redoRound}: ${opts.redoNote ?? ""}`.trim());
      const composed = await composeBrief(role, order);
      if (composed.brief.trim()) job.brief = composed.brief;
      if (composed.refs.length) job.refs = composed.refs;
      job.spec = undefined;
      saveJob(job);
    }
    if (order.status === "PENDING_ACCEPT") {
      const verdict = await spec.assess(job);
      if (!verdict.ok) {
        if (job.status !== "awaiting_input" && job.conversationId && verdict.question) await postNotice(role, job.conversationId, verdict.question);
        if (job.status !== "awaiting_input") job.askedAt = new Date().toISOString();
        job.status = "awaiting_input";
        saveJob(job);
        t.log.info(`order ${orderId}: brief not workable yet, asked the buyer; not accepting until they answer`);
        return job;
      }
      order = await acceptOrder(job, order);
    }
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      t.log.info(`order ${orderId}: status ${order.status}, nothing to do`);
      return job;
    }
    if (["queued", "accepting", "awaiting_input", "failed", "working"].includes(job.status)) {
      job.status = "working";
      job.error = undefined;
      job.attempts += 1;
      saveJob(job);
      await notify("job.working", { role, orderId, jobId: job.id });
      const plan = await spec.plan(job);
      job.spec = plan;
      saveJob(job);
      const d = await spec.work(job, plan);
      fs.writeFileSync(path.join(job.dir, "deliverable.json"), JSON.stringify(d, null, 2));
      job.status = "built";
      saveJob(job);
      await deliver(job, d);
    } else if (job.status === "built" || job.status === "delivering") {
      const d = JSON.parse(fs.readFileSync(path.join(job.dir, "deliverable.json"), "utf8")) as Deliverable;
      await deliver(job, d);
    }
    if (job.status === "delivered") {
      await notify("job.delivered", { role, orderId, jobId: job.id, tx: job.txHashes });
      if (job.conversationId) {
        const d = JSON.parse(fs.readFileSync(path.join(job.dir, "deliverable.json"), "utf8")) as Deliverable;
        await postNotice(role, job.conversationId, d.summary).catch((err) => t.log.warn(`could not post delivery notice: ${String(err)}`));
      }
    }
    return job;
  } catch (err) {
    job.status = "failed";
    job.error = String(err instanceof Error ? err.message : err);
    saveJob(job);
    t.log.error(`order ${orderId}: failed — ${job.error}`);
    await notify("job.failed", { role, orderId, jobId: job.id, error: job.error });
    throw err;
  }
}

const PAGE_SIZE = 100;
/** How far back the newest-first scan looks for PENDING_ACCEPT orders. */
const PENDING_SCAN_MS = 3 * 24 * 3600_000;

/** Provider orders across all pages, newest first (the list defaults to 20 per page; see 3dcardagent 0447457). */
export async function listProviderOrders(role: Role, query: { status?: string; newerThanMs?: number } = {}): Promise<Order[]> {
  const out: Order[] = [];
  for (let page = 1; page <= 100; page++) {
    const status = query.status ? `&status=${query.status}` : "";
    const res = await termix(role).get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider&pageSize=${PAGE_SIZE}&page=${page}${status}`);
    const items = Array.isArray(res) ? res : (res.items ?? []);
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (query.newerThanMs && items.some((o) => typeof o.createdAt === "string" && Date.parse(o.createdAt) < query.newerThanMs!)) break;
  }
  return out;
}

const deliveryDue = (o: Order) => o.deliveryDueAt ?? (o.deadlines as { deliveryDueAt?: string } | undefined)?.deliveryDueAt;
const overdueWarned = new Set<string>();

/** Buyer orders (not sub-task children) that need work: accept / build / redo / reconcile. */
export async function sweepOrders(role: Role): Promise<string[]> {
  const t = termix(role);
  const lists = await Promise.all([
    listProviderOrders(role, { newerThanMs: Date.now() - PENDING_SCAN_MS }),
    ...["FUNDED", "IN_PROGRESS", "DELIVERED"].map((status) => listProviderOrders(role, { status })),
  ]);
  const items = [...new Map(lists.flat().map((o) => [o.id, o])).values()];
  const actionable: string[] = [];
  for (const o of items) {
    if (!ownsOrder(role, o) || isChildOrder(o)) continue;
    const job = findJobByOrder(role, o.id);
    if (o.status === "PENDING_ACCEPT") {
      const due = deliveryDue(o);
      if (due && Date.parse(due) < Date.now()) {
        if (!overdueWarned.has(o.id)) t.log.warn(`order ${o.id}: still PENDING_ACCEPT past its delivery deadline ${due}, not accepting`);
        overdueWarned.add(o.id);
      } else actionable.push(o.id);
    } else if ((o.status === "FUNDED" || o.status === "IN_PROGRESS") && (!job || ["queued", "failed", "built", "accepting", "working", "awaiting_input", "delivering"].includes(job.status))) actionable.push(o.id);
    else if (o.status === "IN_PROGRESS" && o.redoUsed && job?.status === "delivered") actionable.push(o.id);
    else if (o.status === "DELIVERED" && job && !["delivered", "settled"].includes(job.status)) {
      t.log.info(`order ${o.id}: DELIVERED on the platform, marking job ${job.id} delivered (was ${job.status})`);
      job.status = "delivered";
      job.error = undefined;
      saveJob(job);
    }
  }
  return actionable;
}

/**
 * Claim escrow for DELIVERED buyer orders whose challenge window has elapsed. For an order that
 * was split, the net goes to the split vault and the prime then pulls its residual with claimRoot
 * (see production.ts), so this is the same call for every role.
 */
export async function claimExpiredDeliveries(role: Role): Promise<number> {
  const t = termix(role);
  const items = await listProviderOrders(role, { status: "DELIVERED" });
  let claimed = 0;
  for (const o of items) {
    if (!ownsOrder(role, o) || isChildOrder(o)) continue;
    if (!o.challengeWindowEndsAt || new Date(o.challengeWindowEndsAt).getTime() > Date.now()) continue;
    try {
      t.log.info(`order ${o.id}: challenge window elapsed, claiming`);
      const prep = await t.api("POST", `/api/v1/orders/${o.id}/claim-after-timeout/prepare`, {});
      const r = await t.tx(intentFrom(prep), { orderId: o.id });
      const job = findJobByOrder(role, o.id);
      if (job) {
        job.txHashes.claimAfterTimeout = r.results?.[0]?.txHash ?? "";
        job.status = "settled";
        saveJob(job);
      }
      claimed++;
      await notify("order.claimed", { role, orderId: o.id, tx: r.results?.[0]?.txHash });
    } catch (err) {
      t.log.warn(`order ${o.id}: claim failed — ${String(err)}`);
    }
  }
  return claimed;
}
