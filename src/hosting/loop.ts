import { getConfig, type Role } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type WatchEvent } from "../termix/client.js";
import { handleChatMessage } from "../jobs/chat.js";
import { claimExpiredDeliveries, processOrder, sweepOrders } from "../jobs/orderWorker.js";
import { claimSplits, processSubtask, sweepInvites } from "../jobs/subtasks.js";
import { findJobByOrder, listJobs, type Job } from "../jobs/store.js";

/** Long jobs (a Montage production waits hours on its crew) must not starve short ones. */
const CONCURRENCY: Record<Role, number> = { montage: 3, renderfarm: 2, beatsmith: 2, sketchboard: 2 };
const INVITE_INTERVAL_MS = 45_000;

/**
 * One hosted agent: `aacp-watch.mjs wait` blocks until a buyer message / funded order appears (its
 * polling is what keeps the agent ONLINE), events are dispatched, and a periodic sweep accepts what
 * events missed, picks up sub-task invitations, and claims money that became claimable.
 */
export class HostingLoop {
  private stopped = false;
  private running = new Map<string, Promise<void>>();
  private queue: Array<{ key: string; run: () => Promise<unknown> }> = [];
  private lastSweep = 0;
  private lastInvites = 0;
  private readonly log;

  constructor(readonly role: Role) {
    this.log = logger(`host:${role}`);
  }

  stop() {
    this.stopped = true;
  }

  get busy(): string[] {
    return [...this.running.keys()];
  }

  private enqueue(key: string, reason: string, run: () => Promise<unknown>) {
    if (this.running.has(key) || this.queue.some((q) => q.key === key)) return;
    this.log.info(`${key}: queued (${reason})`);
    this.queue.push({ key, run });
    this.pump();
  }

  private enqueueOrder(orderId: string, reason: string) {
    this.enqueue(`order:${orderId}`, reason, () => processOrder(this.role, orderId));
  }

  private enqueueSubtask(job: Job) {
    this.enqueue(`subtask:${job.subtaskId}`, "sub-task", () => processSubtask(job));
  }

  private pump() {
    while (this.running.size < CONCURRENCY[this.role] && this.queue.length) {
      const next = this.queue.shift()!;
      const p = next
        .run()
        .then(() => undefined)
        .catch((err) => this.log.error(`${next.key}: ${String(err)}`))
        .finally(() => {
          this.running.delete(next.key);
          this.pump();
        });
      this.running.set(next.key, p);
    }
  }

  private dispatch(ev: WatchEvent) {
    switch (ev.type) {
      case "chat.message":
        handleChatMessage(this.role, ev, {
          // A buyer we were waiting on (missing brief) answered: try the order again.
          onBuyerReply: (conversationId) => {
            for (const j of listJobs(this.role)) if (j.status === "awaiting_input" && j.conversationId === conversationId) this.enqueueOrder(j.orderId, "buyer answered");
          },
        }).catch((err) => this.log.error(`chat ${ev.conversationId}: ${String(err)}`));
        break;
      case "order.funded":
        if (ev.orderId) this.enqueueOrder(String(ev.orderId), "order.funded event");
        break;
      case "hosting.handoff":
        this.log.info(ev.what ?? "cloud hosting paused; this runtime answers now");
        break;
      default:
        this.log.debug(`event ${ev.type}`, ev);
    }
  }

  private async sweep() {
    const { jobs } = getConfig();
    if (this.role !== "montage" && Date.now() - this.lastInvites > INVITE_INTERVAL_MS) {
      this.lastInvites = Date.now();
      await sweepInvites(this.role, (job) => this.enqueueSubtask(job)).catch((err) => this.log.warn(`invite sweep failed: ${String(err)}`));
    }
    if (Date.now() - this.lastSweep < jobs.sweepIntervalSeconds * 1000) return;
    this.lastSweep = Date.now();
    try {
      for (const id of await sweepOrders(this.role)) this.enqueueOrder(id, findJobByOrder(this.role, id)?.status === "delivered" ? "redo" : "sweep");
      // Sub-tasks whose work was interrupted by a restart.
      for (const j of listJobs(this.role)) if (j.kind === "subtask" && ["queued", "working", "built", "delivering"].includes(j.status) && !j.orderId.startsWith("pending:")) this.enqueueSubtask(j);
      const claimed = (await claimExpiredDeliveries(this.role)) + (await claimSplits(this.role));
      if (claimed) this.log.info(`claimed ${claimed} payout(s)`);
    } catch (err) {
      this.log.warn(`sweep failed: ${String(err)}`);
    }
  }

  async run(): Promise<void> {
    const t = termix(this.role);
    const agentId = t.agentId;
    this.log.info(`hosting ${this.role} (${agentId}) on chain ${getConfig().termix.chain}`);
    await t.ensureRuntimeToken();
    await t.hostingOff(agentId).catch(() => undefined);
    await notify("hosting.started", { role: this.role, agentId });
    let failures = 0;
    while (!this.stopped) {
      await this.sweep();
      try {
        const res = await t.wait(agentId, 45, 10);
        failures = 0;
        for (const ev of res.events) this.dispatch(ev);
        if (res.errors?.length) this.log.warn("watch reported source errors", res.errors);
      } catch (err) {
        failures++;
        const backoff = Math.min(300, 10 * 2 ** Math.min(failures, 5));
        this.log.error(`watch failed (${failures}): ${String(err).slice(0, 400)} — retrying in ${backoff}s`);
        if (failures === 3) await notify("hosting.degraded", { role: this.role, error: String(err) });
        await sleep(backoff * 1000);
      }
    }
    await Promise.allSettled([...this.running.values()]);
    await notify("hosting.stopped", { role: this.role });
  }
}
