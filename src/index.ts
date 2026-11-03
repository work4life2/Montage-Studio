#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getConfig, isRole, ROLES, type Role } from "./config.js";
import { initLogFile } from "./log.js";
import { mcp } from "./mcp/client.js";
import { authorize, isProvider, loadGrant, PROVIDERS } from "./mcp/oauth.js";
import { generateCovers } from "./cli/covers.js";
import { printChecks, runDoctor } from "./cli/doctor.js";
import { listingsSetup, prepareSamples, previewListings } from "./cli/setup.js";
import { formatBreakdown } from "./pricing.js";
import { relayBalance } from "./relay.js";
import { roleSpec } from "./roles/index.js";
import { HostingLoop } from "./hosting/loop.js";
import { startHttp } from "./server/http.js";
import { createJob, listJobs } from "./jobs/store.js";
import { run } from "./util/exec.js";

const USAGE = `montage-studio <command>

  serve                                 host every agent in SERVE_ROLES (default: all four) and take orders
  doctor                                check tools, keys, accounts and wallets
  auth <runway|suno> | auth status      sign in with the account once (browser); refresh token kept in data/oauth/
  setup venv                            python venv with librosa for beat detection (data/venv)
  setup covers [--force]                generate the listing covers (cun.ai, gpt-image-2)
  setup listing <role|all> [--update]   publish (or update) the listings; prices are computed cost-plus
  setup preview [role]                  print the listing texts and package prices without publishing
  setup samples <tiny-arms dir>         portfolio images for the listings (data/samples/<role>/)
  quote <role> '<estimate json>'        price an estimate, with the cost breakdown
  make <role> "<brief>" ['<estimate>']  run one job locally (no marketplace) into data/<role>/jobs/local-*
  jobs [role]                           list jobs
  mcp <runway|suno> tools [--json] | call <tool> '<json>'
  balance                               cun.ai relay spend

Roles: ${ROLES.join(", ")}
`;

function roleArg(x: string | undefined): Role {
  if (!x || !isRole(x)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  return x;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = getConfig();
  initLogFile(path.join(cfg.dataDir, "logs"));
  switch (cmd) {
    case "serve": {
      const loops = cfg.serveRoles.map((r) => new HostingLoop(r));
      startHttp(loops);
      const stop = () => loops.forEach((l) => l.stop());
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      await Promise.all(loops.map((l) => l.run()));
      process.exit(0);
      return;
    }
    case "doctor": {
      printChecks(await runDoctor({ network: true }));
      return;
    }
    case "auth": {
      const p = rest[0];
      if (p === "status" || !p) {
        for (const id of Object.keys(PROVIDERS)) {
          const g = isProvider(id) ? loadGrant(id) : undefined;
          process.stdout.write(`${id}: ${g ? `connected ${g.obtainedAt}${g.refreshToken ? ", refresh token" : ", NO refresh token"}${g.refreshedAt ? `, refreshed ${g.refreshedAt}` : ""}` : "not connected"}\n`);
        }
        return;
      }
      if (!isProvider(p)) throw new Error(`unknown provider ${p}`);
      await authorize(p);
      const tools = await mcp(p).listTools();
      process.stdout.write(`✅ ${PROVIDERS[p].label} connected — ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);
      return;
    }
    case "mcp": {
      const [p, sub, name, json] = rest;
      if (!p || !isProvider(p)) throw new Error("mcp <runway|suno> tools|call");
      if (sub === "tools") {
        const tools = await mcp(p).listTools();
        if (rest.includes("--json")) process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
        else for (const t of tools) process.stdout.write(`${t.name}\n  ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 300)}\n`);
        return;
      }
      if (sub === "call" && name) {
        const r = await mcp(p).call(name, json ? (JSON.parse(json) as Record<string, unknown>) : {});
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        return;
      }
      throw new Error("mcp <runway|suno> tools|call <tool> '<json>'");
    }
    case "setup": {
      const sub = rest[0];
      if (sub === "covers") {
        process.stdout.write((await generateCovers(undefined, rest.includes("--force"))).join("\n") + "\n");
        return;
      }
      if (sub === "listing") {
        const which = rest[1] ?? "all";
        await listingsSetup(which === "all" ? [...ROLES] : [roleArg(which)], rest.includes("--update"));
        return;
      }
      if (sub === "samples") {
        if (!rest[1]) throw new Error("setup samples <path to termix-aacp/packages/e2e/demos/tiny-arms>");
        await prepareSamples(path.resolve(rest[1]));
        return;
      }
      if (sub === "preview") {
        previewListings(rest[1] ? [roleArg(rest[1])] : undefined);
        return;
      }
      if (sub === "venv") {
        const venv = path.join(cfg.dataDir, "venv");
        for (const [c, a] of [
          ["python3", ["-m", "venv", venv]],
          [path.join(venv, "bin", "pip"), ["install", "-q", "--upgrade", "pip"]],
          [path.join(venv, "bin", "pip"), ["install", "-q", "librosa", "soundfile", "pillow"]],
        ] as Array<[string, string[]]>) {
          const r = await run(c, a, { timeoutMs: 30 * 60_000, onStderr: (s) => process.stderr.write(s) });
          if (r.code !== 0) throw new Error(`${c} ${a.join(" ")} failed`);
        }
        process.stdout.write(`✅ venv ready: ${venv}\n`);
        return;
      }
      printChecks(await runDoctor({ network: true }));
      process.stdout.write(`\nNext: npm run setup -- venv · npm run auth -- runway · npm run auth -- suno · npm run setup -- listing all · npm start\n`);
      return;
    }
    case "quote": {
      const role = roleArg(rest[0]);
      const est = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {};
      for (const subtask of [false, true]) {
        const p = roleSpec(role).price(est, { subtask });
        process.stdout.write(`${subtask ? "as a sub-task" : "buyer order"}: ${p.price} ${cfg.currency}, ${p.deliveryDays} day(s)\n  ${formatBreakdown(p, cfg.currency)}\n`);
      }
      return;
    }
    case "make": {
      const role = roleArg(rest[0]);
      const brief = rest[1];
      if (!brief) throw new Error('make <role> "<brief>" [\'<estimate json>\']');
      const spec = roleSpec(role);
      if (role === "montage") throw new Error("montage runs only against a funded order (it hires the crew through sub-tasks)");
      const job = createJob({ role, kind: "order", id: `local-${Date.now()}`, orderId: `local:${Date.now()}`, brief, estimate: rest[2] ? (JSON.parse(rest[2]) as Record<string, unknown>) : undefined });
      const plan = await spec.plan(job);
      fs.writeFileSync(path.join(job.dir, "plan.json"), JSON.stringify(plan, null, 2));
      const d = await spec.work(job, plan);
      process.stdout.write(`${JSON.stringify(d, null, 2)}\nspend: $${(job.spend ?? []).reduce((a, s) => a + s.usd, 0).toFixed(3)}\n`);
      return;
    }
    case "jobs": {
      for (const role of rest[0] ? [roleArg(rest[0])] : ROLES) {
        for (const j of listJobs(role)) process.stdout.write(`${role}\t${j.id}\t${j.status}\t${j.orderId}\t$${(j.spend ?? []).reduce((a, s) => a + s.usd, 0).toFixed(2)}${j.error ? `\t${j.error.slice(0, 80)}` : ""}\n`);
      }
      return;
    }
    case "covers": {
      process.stdout.write((await generateCovers(undefined, rest.includes("--force"))).join("\n") + "\n");
      return;
    }
    case "balance": {
      process.stdout.write(JSON.stringify(await relayBalance()) + "\n");
      return;
    }
    default:
      process.stdout.write(USAGE);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
