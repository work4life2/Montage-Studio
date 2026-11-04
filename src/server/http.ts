import http from "node:http";
import { getConfig, ROLES } from "../config.js";
import { logger } from "../log.js";
import type { HostingLoop } from "../hosting/loop.js";
import { listJobs } from "../jobs/store.js";
import { runwayCredits } from "../providers/runway.js";

const log = logger("http");

/** Runway credits, cached: whoami runs in this process so the OAuth refresh stays under its lock. */
const CREDITS_TTL_MS = 5 * 60_000;
let credits: { at: number; body: Promise<{ credits?: number; error?: string; fetchedAt: string }> } | undefined;

function runwayCreditsCached() {
  if (!credits || Date.now() - credits.at > CREDITS_TTL_MS) {
    const body = runwayCredits()
      .then((total) => ({ credits: total, fetchedAt: new Date().toISOString() }))
      .catch((err: Error) => ({ error: err.message, fetchedAt: new Date().toISOString() }));
    credits = { at: Date.now(), body };
  }
  return credits.body;
}

/**
 * Health, a read-only job list and the Runway credit balance for the operator (and ops-sentinel). Binds to 127.0.0.1 by default: reach it through
 * `ssh -L 8795:127.0.0.1:8795 <server>`. Nothing here is ever linked to buyers.
 */
export function startHttp(loops: HostingLoop[]): http.Server {
  const cfg = getConfig();
  const dash = cfg.http.dashboardPath;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    if (url.pathname === "/health") {
      return json(200, { ok: true, chain: cfg.termix.chain, agents: Object.fromEntries(loops.map((l) => [l.role, { agentId: cfg.agents[l.role].agentId, busy: l.busy }])) });
    }
    if (url.pathname === `${dash}/api/jobs`) {
      const roles = ROLES.filter((r) => !url.searchParams.get("role") || url.searchParams.get("role") === r);
      return json(
        200,
        Object.fromEntries(
          roles.map((r) => [
            r,
            listJobs(r)
              .slice(0, 100)
              .map((j) => ({ id: j.id, kind: j.kind, orderId: j.orderId, subtaskId: j.subtaskId, status: j.status, error: j.error, updatedAt: j.updatedAt, spendUsd: (j.spend ?? []).reduce((a, s) => a + s.usd, 0), tx: j.txHashes, production: j.production ? summarize(j.production) : undefined })),
          ]),
        ),
      );
    }
    if (url.pathname === `${dash}/api/runway/credits`) {
      void runwayCreditsCached().then((body) => json(body.error ? 502 : 200, body));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(cfg.http.port, cfg.http.host, () => log.info(`http on ${cfg.http.host}:${cfg.http.port} (health: /health, jobs: ${dash}/api/jobs, credits: ${dash}/api/runway/credits)`));
  return server;
}

function summarize(p: unknown) {
  const x = p as { crew?: Record<string, { status: string; subtaskId?: string; childOrderId?: string; amount: string }>; plan?: { title?: string } };
  return { title: x.plan?.title, crew: Object.fromEntries(Object.entries(x.crew ?? {}).map(([k, v]) => [k, { status: v.status, amount: v.amount, subtaskId: v.subtaskId, childOrderId: v.childOrderId }])) };
}
