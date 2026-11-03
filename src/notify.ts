import { getConfig } from "./config.js";
import { logger } from "./log.js";

const log = logger("notify");

/** Best-effort POST of an operator-facing event to NOTIFY_WEBHOOK_URL (sign requests, deliveries, failures). */
export async function notify(event: string, payload: Record<string, unknown> = {}): Promise<void> {
  const url = getConfig().jobs.notifyWebhook;
  const body = { event, at: new Date().toISOString(), ...payload };
  log.info(`event ${event}`, payload);
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn(`webhook failed: ${String(err)}`);
  }
}
