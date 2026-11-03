import fs from "node:fs";
import { getConfig, ROLES } from "../config.js";
import { python } from "../media/util.js";
import { loadGrant, PROVIDERS, type ProviderId } from "../mcp/oauth.js";
import { addressFromKey } from "../termix/wallet.js";
import { run } from "../util/exec.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function bin(cmd: string, args: string[]): Promise<Check> {
  const r = await run(cmd, args, { timeoutMs: 30_000 });
  return { name: cmd, ok: r.code === 0, detail: (r.stdout || r.stderr).split("\n")[0].slice(0, 120) };
}

export async function runDoctor(opts: { network?: boolean } = {}): Promise<Check[]> {
  const cfg = getConfig();
  const checks: Check[] = [];
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node });
  checks.push(await bin("ffmpeg", ["-version"]));
  checks.push(await bin("ffprobe", ["-version"]));
  checks.push(await bin("zip", ["-v"]));
  checks.push(await bin("unzip", ["-v"]));
  const py = await run(python(), ["-I", "-c", "import PIL, json; import importlib.util as u; print(json.dumps({'pillow': PIL.__version__, 'librosa': bool(u.find_spec('librosa'))}))"], { timeoutMs: 60_000 });
  checks.push({ name: "python (Pillow, librosa)", ok: py.code === 0, detail: py.code === 0 ? `${python()} ${py.stdout.trim()}` : py.stderr.slice(-200) });
  checks.push({ name: "RELAY_API_KEY", ok: Boolean(cfg.relay.apiKey), detail: cfg.relay.apiKey ? `${cfg.relay.baseUrl} (chat ${cfg.relay.chatModel}, plan ${cfg.relay.planModel}, image ${cfg.relay.imageModel})` : "missing in .env.local" });
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
    const g = loadGrant(p);
    checks.push({ name: `${PROVIDERS[p].label} account`, ok: Boolean(g?.refreshToken), detail: g ? `connected ${g.obtainedAt}${g.refreshedAt ? `, refreshed ${g.refreshedAt}` : ""}` : `not connected — npm run auth -- ${p}` });
  }
  for (const role of ROLES) {
    const a = cfg.agents[role];
    let detail = a.walletKey ? await addressFromKey(a.walletKey) : "WALLET_KEY missing";
    let ok = Boolean(a.walletKey);
    if (ok && opts.network) {
      try {
        const res = await fetch(cfg.termix.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [detail, "latest"] }),
          signal: AbortSignal.timeout(15_000),
        });
        const bnb = Number(BigInt((await res.json()).result)) / 1e18;
        detail += ` · ${bnb.toFixed(5)} BNB`;
        ok = bnb > 0.0003;
      } catch (err) {
        detail += ` · balance unknown (${String(err).slice(0, 60)})`;
      }
    }
    checks.push({ name: `${role} wallet`, ok, detail: `${detail} · agent ${a.agentId}${a.listingId ? ` · listing ${a.listingId}` : " · no listing yet"}` });
  }
  checks.push({ name: "termix skill", ok: fs.existsSync(`${cfg.termixSkillDir}/SKILL.md`), detail: fs.existsSync(`${cfg.termixSkillDir}/VERSION`) ? fs.readFileSync(`${cfg.termixSkillDir}/VERSION`, "utf8").trim() : "missing" });
  return checks;
}

export function printChecks(checks: Check[]): void {
  for (const c of checks) process.stdout.write(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}\n`);
}
