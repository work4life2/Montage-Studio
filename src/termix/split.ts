import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TermixClient, TxIntent } from "./client.js";

/**
 * Sub-tasks ("Split this order") on top of the generic order lifecycle. The skill ships no
 * split helper, so these wrap the backend routes directly (packages/backend/src/services/subtasks.ts):
 *
 *   prime:     POST /orders/:id/subtasks → /subtasks/:id/chats → /subtasks/:id/share → /subtasks/:id/assign/prepare (splitPropose)
 *   assignee:  GET /me/subtask-invites → /subtasks/:id/accept/prepare (splitAcceptProposal) → child order (FUNDED)
 *              → normal delivery on the child order → after the root settles: /orders/:child/split/claim/prepare
 *   prime:     /orders/:child/accept/prepare (releaseEscrow) → … → /orders/:root/split/claim/prepare (claimRoot)
 *
 * A sub-task can only go to an agent of a DIFFERENT account, which is why every studio agent has its own wallet.
 */

export interface SubtaskItem {
  id: string;
  parentOrderId: string;
  title: string;
  scope: string;
  amount: string;
  currency: string;
  dueAt: string;
  status: "DRAFT" | "ASSIGNED" | "ACCEPTED" | "CANCELLED" | "DELETED" | string;
  assignee?: { id?: string; name?: string } | null;
  pendingAgent?: { id?: string } | null;
  childOrderId?: string | null;
  childOrder?: { id: string; status: string; outcome?: string | null; deliveryDueAt?: string; deliveredAt?: string | null; claimedAmount?: string | null } | null;
  acceptBy?: string | null;
}

export interface SplitPanel {
  order: { id: string; title?: string; status: string; budget: string; currency: string };
  cap: string;
  assigned: string;
  drafts: string;
  remaining: string;
  dueCap: string;
  splitSupported: boolean;
  splitOpen: boolean;
  splitClosedReason?: string | null;
  teamConversationId?: string | null;
  items: SubtaskItem[];
}

export interface SubtaskInvite {
  id: string;
  title: string;
  scope: string;
  amount: string;
  currency: string;
  dueAt: string;
  status: string;
  standing: "OPEN" | "ASSIGNED_TO_YOU" | "ASSIGNED_ELSEWHERE" | "ACCEPTED_BY_YOU" | "GIVEN_TO_OTHER" | "CLOSED" | string;
  owner?: { id?: string; name?: string; displayName?: string } | null;
  myAgentId?: string | null;
  acceptBy?: string | null;
  acceptOpen?: boolean;
  childOrderId?: string | null;
  conversationId?: string | null;
  createdAt: string;
}

function intentOf(res: unknown): TxIntent {
  const r = res as Record<string, unknown>;
  const candidate = (r.txIntent ?? r.intent ?? r) as TxIntent;
  if (!candidate || (!candidate.callData && !candidate.data)) throw new Error(`no tx-intent in response: ${JSON.stringify(res).slice(0, 300)}`);
  return candidate;
}

export class Split {
  constructor(private readonly t: TermixClient) {}

  // ─── prime ─────────────────────────────────────────────────────────

  panel(orderId: string) {
    return this.t.get<SplitPanel>(`/api/v1/orders/${orderId}/subtasks`);
  }

  create(orderId: string, body: { title: string; scope: string; skills?: string[]; amount: string; dueAt: string }) {
    return this.t.api<SubtaskItem>("POST", `/api/v1/orders/${orderId}/subtasks`, body);
  }

  update(subtaskId: string, body: Partial<{ title: string; scope: string; amount: string; dueAt: string }>) {
    return this.t.api<SubtaskItem>("PATCH", `/api/v1/subtasks/${subtaskId}`, body);
  }

  remove(subtaskId: string) {
    return this.t.api("DELETE", `/api/v1/subtasks/${subtaskId}`);
  }

  /** Open the 1:1 thread and post the task card: the agent becomes a candidate that can be assigned. */
  async invite(subtaskId: string, agentId: string): Promise<{ conversationId: string }> {
    await this.t.api("POST", `/api/v1/subtasks/${subtaskId}/chats`, { agentId });
    return this.t.api<{ conversationId: string }>("POST", `/api/v1/subtasks/${subtaskId}/share`, { agentId });
  }

  /** On-chain proposal (splitPropose): amount + due date come from the sub-task itself. */
  async assign(subtaskId: string, agentId: string, context?: Record<string, unknown>) {
    const prep = await this.t.api("POST", `/api/v1/subtasks/${subtaskId}/assign/prepare`, { agentId });
    return this.t.tx(intentOf(prep), { subtaskId, ...context });
  }

  /** Team channel of the root order (created on first read, prime only). */
  team(orderId: string) {
    return this.t.get<{ conversation: { id: string }; members: Array<{ agent: { id: string; name?: string }; role: string }> }>(`/api/v1/orders/${orderId}/team`);
  }

  /** Accept a sub-contractor's delivery (releaseEscrow on the split vault). */
  async release(childOrderId: string) {
    const prep = await this.t.api("POST", `/api/v1/orders/${childOrderId}/accept/prepare`, {});
    return this.t.tx(intentOf(prep), { orderId: childOrderId });
  }

  async requestRedo(childOrderId: string, note: string) {
    const prep = await this.t.api("POST", `/api/v1/orders/${childOrderId}/redo/prepare`, { note: note.slice(0, 2000) });
    return this.t.tx(intentOf(prep), { orderId: childOrderId });
  }

  // ─── assignee ──────────────────────────────────────────────────────

  async invites(): Promise<SubtaskInvite[]> {
    const res = await this.t.get<{ items?: SubtaskInvite[] }>("/api/v1/me/subtask-invites");
    return res.items ?? [];
  }

  async acceptProposal(subtaskId: string) {
    const prep = await this.t.api("POST", `/api/v1/subtasks/${subtaskId}/accept/prepare`, {});
    return this.t.tx(intentOf(prep), { subtaskId });
  }

  async declineProposal(subtaskId: string) {
    const prep = await this.t.api("POST", `/api/v1/subtasks/${subtaskId}/decline/prepare`, {});
    return this.t.tx(intentOf(prep), { subtaskId });
  }

  /** Pull this party's share once the root order has settled (child: payee; root: prime). */
  async claim(orderId: string) {
    const prep = await this.t.api("POST", `/api/v1/orders/${orderId}/split/claim/prepare`, {});
    return this.t.tx(intentOf(prep), { orderId });
  }

  // ─── conversations (team channel + 1:1 threads) ────────────────────

  async post(conversationId: string, text: string, metadata?: Record<string, unknown>) {
    return this.t.api<{ id: string }>("POST", `/api/v1/conversations/${conversationId}/messages`, {
      text: text.slice(0, 10_000),
      fromAgentId: this.t.agentId,
      clientMessageId: crypto.randomUUID(),
      ...(metadata ? { metadata } : {}),
    });
  }

  async messages(conversationId: string, afterSeq?: number): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let after = afterSeq;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ pageSize: "100" });
      if (after !== undefined) q.set("afterSeq", String(after));
      const res = await this.t.get<{ items?: Array<Record<string, unknown>> }>(`/api/v1/conversations/${conversationId}/messages?${q}`);
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < 100) break;
      after = Number(items[items.length - 1].seq);
    }
    return out;
  }

  /** Upload a file into a conversation; message attachments are publicly readable by URL. */
  async attach(conversationId: string, file: string, contentType: string): Promise<{ url: string; messageId?: string }> {
    const sizeBytes = fs.statSync(file).size;
    const up = await this.t.api<{ uploadUrl: string; s3Key: string; publicUrl: string }>("POST", `/api/v1/conversations/${conversationId}/attachments/upload-url`, {
      fileName: path.basename(file),
      contentType,
      sizeBytes,
    });
    const done = await this.t.upload(up.uploadUrl, file, contentType);
    const att = await this.t.api<{ url?: string; messageId?: string }>("POST", `/api/v1/conversations/${conversationId}/attachments`, {
      s3Key: up.s3Key,
      url: up.publicUrl,
      sha256: done.sha256,
      contentType,
      sizeBytes,
    });
    return { url: att.url ?? up.publicUrl, messageId: att.messageId };
  }
}
