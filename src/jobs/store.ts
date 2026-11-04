import fs from "node:fs";
import path from "node:path";
import { roleDir, type Role } from "../config.js";

export type JobStatus =
  | "queued"
  | "awaiting_input"
  | "accepting"
  | "working"
  | "built"
  | "delivering"
  | "delivered"
  | "settled"
  | "failed";

/** order = a buyer's order sold by this agent; subtask = a child order we took from a prime (Montage or anyone). */
export type JobKind = "order" | "subtask";

export interface JobArtifact {
  name: string;
  file: string;
  contentType: string;
  sizeBytes?: number;
  sha256?: string;
  artifactId?: string;
  url?: string;
}

export interface Job {
  id: string;
  role: Role;
  kind: JobKind;
  /** Termix order id (the child order for sub-tasks), or "local:<name>" for `make` runs. */
  orderId: string;
  subtaskId?: string;
  conversationId?: string;
  status: JobStatus;
  brief: string;
  refs: string[];
  /** Role-specific work spec (shot list, song spec, …) once planned. */
  spec?: unknown;
  /** Quote parameters the price was computed from (copied from the accepted offer when known). */
  estimate?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  redoRound: number;
  error?: string;
  dir: string;
  artifacts: JobArtifact[];
  txHashes: Record<string, string>;
  notes: string[];
  /** Provider spend recorded while working (credits, images), for the cost ledger. */
  spend?: Array<{ what: string; usd: number; units?: number; at: string }>;
  /** Montage only: the production state machine (sub-tasks, phases, edit). */
  production?: unknown;
  /** When the money arrived (our claim, a split claim, or the buyer's early release); updatedAt keeps moving. */
  settledAt?: string;
  /** Last time we asked the buyer for missing input (awaiting_input). */
  askedAt?: string;
}

export interface OfferRecord {
  offerId: string;
  revisionId?: string;
  version?: number;
  price: string;
  currency: string;
  deliveryDays: number;
  scope: string;
  at: string;
  status: "active" | "accepted" | "withdrawn" | "superseded";
  estimate?: Record<string, unknown>;
  breakdown?: Array<{ item: string; usd: number }>;
}

export interface ConversationLog {
  id: string;
  orderId?: string;
  kind?: string;
  buyer?: string;
  messages: Array<{ role: "buyer" | "agent"; text: string; at: string; messageId?: string; from?: string; refs?: string[] }>;
  offers?: OfferRecord[];
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

export function jobPath(role: Role, id: string) {
  return path.join(roleDir(role, "jobs"), safe(id));
}

/** Mark a job settled, keeping the settlement time separate from updatedAt. */
export function markSettled(job: Job, at?: string): Job {
  job.status = "settled";
  job.settledAt = at && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString();
  return saveJob(job);
}

export function saveJob(job: Job): Job {
  job.updatedAt = new Date().toISOString();
  fs.mkdirSync(job.dir, { recursive: true });
  const file = path.join(job.dir, "job.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(job, null, 2));
  fs.renameSync(file + ".tmp", file);
  return job;
}

export function loadJob(role: Role, id: string): Job | undefined {
  const file = path.join(jobPath(role, id), "job.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Job;
}

export function listJobs(role: Role): Job[] {
  const out: Job[] = [];
  for (const name of fs.readdirSync(roleDir(role, "jobs"))) {
    const j = loadJob(role, name);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findJobByOrder(role: Role, orderId: string): Job | undefined {
  return listJobs(role).find((j) => j.orderId === orderId);
}

export function findJobBySubtask(role: Role, subtaskId: string): Job | undefined {
  return listJobs(role).find((j) => j.subtaskId === subtaskId);
}

export function createJob(init: { role: Role; kind: JobKind; id: string; orderId: string; brief: string; refs?: string[]; conversationId?: string; subtaskId?: string; estimate?: Record<string, unknown> }): Job {
  const now = new Date().toISOString();
  const job: Job = {
    id: safe(init.id),
    role: init.role,
    kind: init.kind,
    orderId: init.orderId,
    subtaskId: init.subtaskId,
    conversationId: init.conversationId,
    status: "queued",
    brief: init.brief,
    refs: init.refs ?? [],
    estimate: init.estimate,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    redoRound: 0,
    dir: jobPath(init.role, init.id),
    artifacts: [],
    txHashes: {},
    notes: [],
  };
  return saveJob(job);
}

export function recordSpend(job: Job, what: string, usd: number, units?: number): void {
  job.spend ??= [];
  job.spend.push({ what, usd: Math.round(usd * 10000) / 10000, units, at: new Date().toISOString() });
  saveJob(job);
}

export function loadConversation(role: Role, id: string): ConversationLog {
  const file = path.join(roleDir(role, "conversations"), safe(id) + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as ConversationLog;
  return { id, messages: [] };
}

export function saveConversation(role: Role, c: ConversationLog): void {
  fs.writeFileSync(path.join(roleDir(role, "conversations"), safe(c.id) + ".json"), JSON.stringify(c, null, 2));
}

/** The quote (with its estimate) that an order was created from, looked up in our conversation logs. */
export function findOfferRecord(role: Role, offerId: string): OfferRecord | undefined {
  const dir = roleDir(role, "conversations");
  for (const name of fs.readdirSync(dir)) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ConversationLog;
      const hit = c.offers?.find((o) => o.offerId === offerId);
      if (hit) return hit;
    } catch {
      /* skip */
    }
  }
  return undefined;
}
