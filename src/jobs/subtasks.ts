import fs from "node:fs";
import path from "node:path";
import { getConfig, type Role } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix } from "../termix/client.js";
import { Split, type SubtaskInvite } from "../termix/split.js";
import { roleSpec } from "../roles/index.js";
import type { Deliverable } from "../roles/types.js";
import { createJob, findJobBySubtask, listJobs, saveJob, type Job } from "./store.js";
import { deliver, getOrder, type Order } from "./orderWorker.js";

const log = logger("subtasks");

/** Montage Studio posts each brief as brief-<subtaskId>.json in the 1:1 thread; anyone else only has the scope text. */
async function readBrief(role: Role, inv: SubtaskInvite): Promise<{ spec?: unknown; thread: string }> {
  if (!inv.conversationId) return { thread: "" };
  const split = new Split(termix(role));
  const msgs = await split.messages(inv.conversationId);
  const lines: string[] = [];
  let spec: unknown;
  for (const m of msgs) {
    const text = String(m.text ?? "");
    const atts = (m.attachments as Array<{ url?: string }> | undefined) ?? [];
    const urls = [text, ...atts.map((a) => a.url ?? "")].filter((u) => u.includes(`brief-${inv.id.toLowerCase()}.json`) || u.includes(`brief-${inv.id}.json`));
    if (urls.length && spec === undefined) {
      try {
        const res = await fetch(urls[0], { signal: AbortSignal.timeout(30_000) });
        const body = (await res.json()) as { subtaskId?: string; spec?: unknown };
        if (body.subtaskId === inv.id) spec = body.spec;
      } catch (err) {
        log.warn(`${role}: brief for ${inv.id} not readable: ${String(err)}`);
      }
    } else if (text && m.kind !== "ATTACHMENT") lines.push(text);
  }
  return { spec, thread: lines.slice(-20).join("\n") };
}

const isStudioPrime = (inv: SubtaskInvite) => inv.owner?.id === getConfig().agents.montage.agentId;

/**
 * Sub-task invitations for one crew agent. Montage Studio's proposals are accepted once its brief is
 * readable (it priced them with our own formula). Anyone else's are planned from their scope and
 * accepted only when the amount covers our cost-plus price; otherwise we decline and say why.
 */
export async function sweepInvites(role: Role, enqueue: (job: Job) => void): Promise<void> {
  const t = termix(role);
  const split = new Split(t);
  const spec = roleSpec(role);
  const invites = await split.invites();
  for (const inv of invites) {
    let job = findJobBySubtask(role, inv.id);
    if (inv.standing === "ACCEPTED_BY_YOU") {
      if (job && inv.childOrderId && job.orderId !== inv.childOrderId) {
        job.orderId = inv.childOrderId;
        saveJob(job);
      }
      if (job && inv.childOrderId && ["queued", "accepting", "failed", "working", "built", "delivering"].includes(job.status)) enqueue(job);
      continue;
    }
    if (inv.standing !== "ASSIGNED_TO_YOU" || inv.acceptOpen === false) continue;
    if (job?.status === "failed" && job.notes.includes("declined")) continue;
    if (!job) {
      const { spec: brief, thread } = await readBrief(role, inv);
      const text = `Sub-task "${inv.title}" from ${inv.owner?.displayName ?? inv.owner?.name ?? "a hiring agent"}: ${inv.amount} ${inv.currency}, due ${inv.dueAt}.\nScope: ${inv.scope}${thread ? `\n\nMessages in our thread:\n${thread}` : ""}`;
      job = createJob({ role, kind: "subtask", id: `subtask-${inv.id}`, orderId: inv.childOrderId ?? `pending:${inv.id}`, subtaskId: inv.id, brief: text, conversationId: inv.conversationId ?? undefined });
      if (brief) job.spec = brief;
      saveJob(job);
      if (!isStudioPrime(inv)) {
        // External prime: plan from their scope and check the money covers it.
        try {
          const plan = await spec.plan(job);
          job.spec = plan;
          const est = spec.estimateOf?.(plan);
          const needed = est ? spec.price(est, { subtask: true }).price : 0;
          if (needed > Number(inv.amount) + 1e-9) {
            job.status = "failed";
            job.notes.push("declined");
            saveJob(job);
            await split.declineProposal(inv.id);
            if (inv.conversationId) await split.post(inv.conversationId, `Thanks for the invite! This scope costs ${needed} ${inv.currency} with us (${spec.name}, cost-plus); the offered ${inv.amount} does not cover it. Re-propose at ${needed} and I accept right away.`);
            log.info(`${role}: declined external sub-task ${inv.id} (${inv.amount} < ${needed})`);
            continue;
          }
        } catch (err) {
          log.warn(`${role}: could not plan external sub-task ${inv.id}: ${String(err)}`);
          continue;
        }
      } else if (!brief) {
        log.info(`${role}: sub-task ${inv.id} from Montage Studio, waiting for its brief`);
        fs.rmSync(job.dir, { recursive: true, force: true });
        continue;
      }
    }
    job.status = "accepting";
    saveJob(job);
    log.info(`${role}: accepting sub-task ${inv.id} on-chain (${inv.amount} ${inv.currency})`);
    try {
      const r = await split.acceptProposal(inv.id);
      job.txHashes.acceptProposal = r.results?.[0]?.txHash ?? "";
      saveJob(job);
      for (let i = 0; i < 30 && !job.orderId.startsWith("c"); i++) {
        await sleep(8000);
        const again = (await split.invites()).find((x) => x.id === inv.id);
        if (again?.childOrderId) job.orderId = again.childOrderId;
      }
      saveJob(job);
      if (job.orderId.startsWith("pending:")) {
        log.warn(`${role}: sub-task ${inv.id} accepted but the child order is not indexed yet; the next sweep picks it up`);
        continue;
      }
      job.status = "queued";
      saveJob(job);
      await notify("subtask.accepted", { role, subtaskId: inv.id, childOrderId: job.orderId });
      enqueue(job);
    } catch (err) {
      job.status = "failed";
      job.error = String(err);
      saveJob(job);
      log.error(`${role}: accepting sub-task ${inv.id} failed: ${String(err)}`);
    }
  }
}

/** Work + deliver one accepted sub-task (its child order follows the normal delivery endpoints). */
export async function processSubtask(job: Job): Promise<Job> {
  const t = termix(job.role);
  const spec = roleSpec(job.role);
  let order: Order = await getOrder(job.role, job.orderId);
  try {
    if (order.status === "IN_PROGRESS" && order.redoUsed && job.status === "delivered") {
      job.redoRound += 1;
      const note = String((order as { redoNote?: string }).redoNote ?? "");
      job.notes.push(`redo ${job.redoRound}: ${note}`);
      job.status = "queued";
      saveJob(job);
    }
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      if (order.status === "DELIVERED" && job.status !== "delivered") {
        job.status = "delivered";
        saveJob(job);
      }
      return job;
    }
    if (["queued", "accepting", "failed", "working"].includes(job.status)) {
      job.status = "working";
      job.error = undefined;
      job.attempts += 1;
      saveJob(job);
      const plan = await spec.plan(job);
      job.spec = plan;
      saveJob(job);
      const d = await spec.work(job, plan);
      fs.writeFileSync(path.join(job.dir, "deliverable.json"), JSON.stringify(d, null, 2));
      job.status = "built";
      saveJob(job);
    }
    if (job.status === "built" || job.status === "delivering") {
      const d = JSON.parse(fs.readFileSync(path.join(job.dir, "deliverable.json"), "utf8")) as Deliverable;
      await deliver(job, d);
      if (job.conversationId) await new Split(t).post(job.conversationId, `Delivered sub-task ${job.subtaskId}: ${d.note.slice(0, 900)}`).catch(() => undefined);
      await notify("subtask.delivered", { role: job.role, subtaskId: job.subtaskId, childOrderId: job.orderId });
    }
    order = await getOrder(job.role, job.orderId);
    return job;
  } catch (err) {
    job.status = "failed";
    job.error = String(err instanceof Error ? err.message : err);
    saveJob(job);
    t.log.error(`sub-task ${job.subtaskId}: failed — ${job.error}`);
    await notify("subtask.failed", { role: job.role, subtaskId: job.subtaskId, error: job.error });
    throw err;
  }
}

/**
 * Pull settled money: assignees claim their child orders, the prime claims its residual on the
 * root (claimRoot). Both only become claimable once the root order settled and every sibling is final.
 */
export async function claimSplits(role: Role): Promise<number> {
  const t = termix(role);
  const split = new Split(t);
  let claimed = 0;
  for (const job of listJobs(role)) {
    if (job.txHashes.splitClaim || job.notes.includes("nothing-to-claim") || job.orderId.startsWith("local:") || job.orderId.startsWith("pending:")) continue;
    const splitJob = job.kind === "subtask" || (role === "montage" && job.production);
    if (!splitJob || !["delivered", "settled"].includes(job.status)) continue;
    let order: Order;
    try {
      order = await getOrder(role, job.orderId);
    } catch {
      continue;
    }
    // The prime's share sits under split.payout; an assignee's fields are on split itself.
    const s = (order.split?.role === "prime" ? (order.split.payout as typeof order.split | undefined) : order.split) ?? undefined;
    if (!s || s.nothingToClaim) {
      if (s?.nothingToClaim) {
        job.notes.push("nothing-to-claim");
        saveJob(job);
      }
      continue;
    }
    if (s.claimBlocker || !(Number(s.claimableAmount ?? 0) > 0)) continue;
    try {
      const r = await split.claim(job.orderId);
      job.txHashes.splitClaim = r.results?.[0]?.txHash ?? "submitted";
      job.status = "settled";
      saveJob(job);
      claimed++;
      t.log.info(`${job.orderId}: claimed ${s.claimableAmount} (${job.kind === "subtask" ? "sub-task payout" : "prime residual"})`);
      await notify("split.claimed", { role, orderId: job.orderId, amount: s.claimableAmount, tx: job.txHashes.splitClaim });
    } catch (err) {
      if (/nothing to claim/i.test(String(err))) {
        job.notes.push("nothing-to-claim");
        saveJob(job);
      } else t.log.warn(`${job.orderId}: claim failed — ${String(err).slice(0, 300)}`);
    }
  }
  return claimed;
}
