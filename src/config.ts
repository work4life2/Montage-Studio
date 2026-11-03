import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the directory that contains package.json / skills / tools). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader: never overrides variables already present in the process env. */
export function loadDotEnv(file = path.join(ROOT, ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function envNum(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The four hosted agents. Each one has its own hot wallet, so they are separate Termix accounts. */
export const ROLES = ["montage", "renderfarm", "beatsmith", "sketchboard"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

/** Agents minted on BSC on 2026-11-03 (public ids; override per role with <ROLE>_AGENT_ID). */
const DEFAULT_AGENT_IDS: Record<Role, string> = {
  montage: "cmw08rnum79p9s201hu28wlbd",
  renderfarm: "cmw08s63x79sas201mxhj3qsw",
  beatsmith: "cmw08son779v9s201slpjpzhb",
  sketchboard: "cmw08t79s79yes20111k0m1hr",
};

export interface AgentConfig {
  role: Role;
  agentId: string;
  walletKey: string;
  /** Published listing (set after `setup listing`); offers in chat are attached to it. */
  listingId: string;
}

export interface Config {
  root: string;
  dataDir: string;
  termixSkillDir: string;
  toolsDir: string;
  agents: Record<Role, AgentConfig>;
  /** Roles this process hosts (SERVE_ROLES, default all four). */
  serveRoles: Role[];
  termix: { chain: string; rpcUrl: string };
  /** OpenAI-compatible relay (cun.ai): chat models + gpt-image-2. */
  relay: { baseUrl: string; apiKey: string; chatModel: string; planModel: string; imageModel: string };
  oauth: { callbackPort: number };
  pricing: {
    runwayUsdPerCredit: number;
    imageUsd: number;
    gasUsdPerTx: number;
    platformFee: number;
    margin: Record<Role, number>;
  };
  http: { port: number; host: string; dashboardPath: string };
  jobs: { timeoutMinutes: number; sweepIntervalSeconds: number; notifyWebhook: string };
  currency: string;
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  loadDotEnv(path.join(ROOT, ".env.local")); // secrets (git-ignored), takes precedence
  loadDotEnv();
  const dataDir = path.resolve(ROOT, env("DATA_DIR", "./data"));
  let published: Record<string, string> = {};
  try {
    published = JSON.parse(fs.readFileSync(path.join(dataDir, "listings.json"), "utf8")) as Record<string, string>;
  } catch {
    /* no listings published yet (npm run setup -- listing) */
  }
  const agents = Object.fromEntries(
    ROLES.map((role) => {
      const R = role.toUpperCase();
      return [role, { role, agentId: env(`${R}_AGENT_ID`, DEFAULT_AGENT_IDS[role]), walletKey: env(`${R}_WALLET_KEY`), listingId: env(`${R}_LISTING_ID`, published[role] ?? "") }];
    }),
  ) as Record<Role, AgentConfig>;
  const serveRoles = env("SERVE_ROLES", ROLES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(isRole);
  cached = {
    root: ROOT,
    dataDir,
    termixSkillDir: path.join(ROOT, "skills", "termix-agent-skills"),
    toolsDir: path.join(ROOT, "tools"),
    agents,
    serveRoles,
    termix: { chain: env("AACP_CHAIN", "bsc"), rpcUrl: env("A2A_RPC_URL", "https://bsc-dataseed.bnbchain.org") },
    relay: {
      baseUrl: env("RELAY_BASE_URL", "https://www.cun.ai").replace(/\/+$/, "").replace(/\/v1$/, ""),
      apiKey: env("RELAY_API_KEY"),
      chatModel: env("CHAT_MODEL", "claude-sonnet-5-5"),
      planModel: env("PLAN_MODEL", "claude-sonnet-5-5"),
      imageModel: env("IMAGE_MODEL", "gpt-image-2"),
    },
    oauth: { callbackPort: envNum("OAUTH_CALLBACK_PORT", 53682) },
    pricing: {
      // Runway Pro: $35 / 2,250 credits.
      runwayUsdPerCredit: envNum("RUNWAY_USD_PER_CREDIT", 0.0156),
      imageUsd: envNum("IMAGE_USD", 0.125),
      gasUsdPerTx: envNum("GAS_USD_PER_TX", 0.02),
      platformFee: 0.02,
      // Cost-plus: price = cost × (1 + margin).
      margin: { montage: 0.5, renderfarm: 0.5, beatsmith: 0.2, sketchboard: 0.2 },
    },
    http: {
      port: envNum("HTTP_PORT", 8795),
      host: env("HTTP_HOST", "127.0.0.1"),
      dashboardPath: env("DASHBOARD_PATH") ? "/" + env("DASHBOARD_PATH").replace(/^\/+|\/+$/g, "") : "",
    },
    jobs: {
      timeoutMinutes: envNum("JOB_TIMEOUT_MINUTES", 240),
      sweepIntervalSeconds: envNum("SWEEP_INTERVAL_SECONDS", 300),
      notifyWebhook: env("NOTIFY_WEBHOOK_URL"),
    },
    currency: env("CURRENCY", "USDC"),
  };
  fs.mkdirSync(cached.dataDir, { recursive: true });
  return cached;
}

/** Per-agent data directory (jobs, conversations, the skill's credential cache). */
export function roleDir(role: Role, ...sub: string[]): string {
  const dir = path.join(getConfig().dataDir, role, ...sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
