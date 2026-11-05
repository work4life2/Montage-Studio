import path from "node:path";
import fs from "node:fs";
import { getConfig, roleDir, type Role } from "../config.js";
import { logger } from "../log.js";
import { lastJson, run, type ExecResult } from "../util/exec.js";


export interface WatchEvent {
  type: "chat.message" | "order.funded" | "offer.received" | "hosting.handoff" | string;
  what?: string;
  hint?: string;
  conversationId?: string;
  messageId?: string;
  orderId?: string;
  from?: string | { displayName?: string; handle?: string; walletAddress?: string };
  text?: string;
  agentId?: string;
  moreQueued?: number;
  /** chat.message: CLIENT = we started this conversation with a seller (skill ≥ 1.11.4). */
  myRole?: "CLIENT" | "PROVIDER" | null;
  /** chat.message: sent by another agent's software, not typed by a person (skill ≥ 1.11.4). */
  fromAutomated?: boolean | null;
  [k: string]: unknown;
}

export interface WatchResult {
  timedOut: boolean;
  waitedSeconds?: number;
  polls?: number;
  watching?: string[];
  events: WatchEvent[];
  errors?: unknown[];
  next?: string;
}

export interface TxIntent {
  action?: string;
  chainId?: number | string;
  contract?: string;
  to?: string;
  callData?: string;
  data?: string;
  value?: string;
  [k: string]: unknown;
}

export interface TxResult {
  mode: string;
  from?: string;
  chainId?: number;
  signRequestId?: string;
  url?: string;
  /** True when the tx was broadcast but the RPC never returned a receipt; the backend's order status decides. */
  pending?: boolean;
  results?: Array<{ action: string; txHash: string; status: string; blockNumber?: number }>;
}

/**
 * Public RPC used to broadcast and confirm transactions. The skill's default for BSC
 * (bsc-rpc.publicnode.com) now answers `eth_getTransactionReceipt` with "Archive requests
 * require a personal token", so every tx looked like a receipt timeout even though it was
 * mined. BNB Chain's own dataseed serves receipts; the operator can still override with A2A_RPC_URL.
 */
export const DEFAULT_RPC_URL: Record<string, string> = {
  bsc: "https://bsc-dataseed.bnbchain.org",
};

/** `[aacp-tx] sent <action> nonce=<n> tx=<hash>` — printed once the raw tx is accepted by the node. */
const SENT_LINE = /\[aacp-tx\] sent (\S+) (?:nonce=\d+ )?tx=(0x[0-9a-fA-F]{64})/g;

export function broadcastHashes(stderr: string): Array<{ action: string; txHash: string }> {
  return [...stderr.matchAll(SENT_LINE)].map((m) => ({ action: m[1], txHash: m[2] }));
}

export class TermixError extends Error {
  constructor(
    message: string,
    public readonly result?: ExecResult,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper over the dependency-free scripts shipped in skills/termix-agent-skills, bound to
 * one hosted agent. Every agent has its own hot wallet (a separate Termix account — the platform
 * refuses sub-tasks between agents of one account), and the scripts cache credentials/cursors in
 * files relative to `cwd`, so each agent runs from its own DATA_DIR/<role>/termix.
 */
export class TermixClient {
  readonly scriptsDir: string;
  readonly cwd: string;
  readonly log: ReturnType<typeof logger>;

  constructor(readonly role: Role) {
    const cfg = getConfig();
    this.scriptsDir = path.join(cfg.termixSkillDir, "scripts");
    this.cwd = roleDir(role, "termix");
    this.log = logger(`termix:${role}`);
  }

  get agentId(): string {
    return getConfig().agents[this.role].agentId;
  }

  private script(name: string): string {
    return path.join(this.scriptsDir, name);
  }

  private env(): NodeJS.ProcessEnv {
    const cfg = getConfig();
    const a = cfg.agents[this.role];
    if (!a.walletKey) throw new TermixError(`${this.role.toUpperCase()}_WALLET_KEY is not set in .env.local`);
    // Key mode only: the service signs locally with this agent's hot wallet.
    const e: NodeJS.ProcessEnv = { AACP_CHAIN: cfg.termix.chain, TERMIX_WALLET_MODE: "key", WALLET_KEY: a.walletKey, A2A_AGENT_ID: a.agentId };
    const rpc = cfg.termix.rpcUrl || DEFAULT_RPC_URL[cfg.termix.chain];
    if (rpc) e.A2A_RPC_URL = rpc;
    return e;
  }

  async node(
    scriptName: string,
    args: string[],
    opts: { timeoutMs?: number; onStderr?: (s: string) => void } = {},
  ): Promise<ExecResult> {
    const res = await run("node", [this.script(scriptName), ...args], {
      cwd: this.cwd,
      env: this.env(),
      timeoutMs: opts.timeoutMs,
      onStderr: opts.onStderr,
    });
    return res;
  }

  private async json<T = unknown>(
    scriptName: string,
    args: string[],
    opts: { timeoutMs?: number; onStderr?: (s: string) => void; allowFail?: boolean } = {},
  ): Promise<T> {
    const res = await this.node(scriptName, args, opts);
    const parsed = lastJson<T>(res.stdout);
    if (res.code !== 0 && !opts.allowFail) {
      const msg = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
      throw new TermixError(`${scriptName} ${args[0] ?? ""} failed (exit ${res.code}): ${msg}`, res);
    }
    if (parsed === undefined) {
      if (opts.allowFail) return undefined as T;
      throw new TermixError(`${scriptName} returned no JSON: ${(res.stdout + res.stderr).slice(-400)}`, res);
    }
    return parsed;
  }

  // ─── identity / setup ──────────────────────────────────────────────

  next() {
    return this.json<Record<string, unknown>>("aacp-next.mjs", [], { allowFail: true });
  }

  private loginPromise: Promise<Record<string, unknown>> | undefined;

  /** Wallet login (nonce → sign with WALLET_KEY → cached session). Idempotent per process. */
  login() {
    this.loginPromise ??= this.json<Record<string, unknown>>("a2a-runtime.mjs", ["login"]).catch((e) => {
      this.loginPromise = undefined;
      throw e;
    });
    return this.loginPromise;
  }

  /** Run a session-authenticated command, logging in first (and once more if the session expired). */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    await this.login();
    try {
      return await fn();
    } catch (err) {
      if (/not logged in|401|UNAUTHORIZED|session/i.test(String(err))) {
        this.loginPromise = undefined;
        await this.login();
        return await fn();
      }
      throw err;
    }
  }

  agents() {
    return this.withSession(() =>
      this.json<{ count: number; items: Array<{ agentId: string; agentTokenId?: string; name: string; a2aStatus?: string }> }>(
        "a2a-runtime.mjs",
        ["agents"],
      ),
    );
  }

  printEnv() {
    return this.json<Record<string, unknown>>("a2a-runtime.mjs", ["print-env"], { allowFail: true });
  }

  updateCheck() {
    return this.json<{ status?: string; installed?: string; latest?: string }>("aacp-update.mjs", ["check"], { allowFail: true });
  }

  // ─── REST ──────────────────────────────────────────────────────────

  async api<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    apiPath: string,
    body?: unknown,
    auth: "session" | "runtime" | "none" = "session",
  ): Promise<T> {
    const args = [method, apiPath, "--auth", auth];
    if (body !== undefined) args.push("--body", JSON.stringify(body));
    const call = () => this.json<T>("aacp-api.mjs", args, { timeoutMs: 120_000 });
    return auth === "none" ? call() : this.withSession(call);
  }

  get<T = unknown>(apiPath: string) {
    return this.api<T>("GET", apiPath);
  }

  // ─── hosting ───────────────────────────────────────────────────────

  /** Blocks until there is work or `timeoutSeconds` elapsed. */
  async wait(agentId: string, timeoutSeconds = 300, intervalSeconds = 10, extra: string[] = []): Promise<WatchResult> {
    const args = ["wait", "--agent", agentId, "--timeout", String(timeoutSeconds), "--interval", String(intervalSeconds), ...extra];
    await this.login();
    const res = await this.node("aacp-watch.mjs", args, { timeoutMs: (timeoutSeconds + 120) * 1000 });
    const parsed = lastJson<WatchResult>(res.stdout);
    if (!parsed) {
      throw new TermixError(`aacp-watch wait failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-600)}`, res);
    }
    parsed.events ??= [];
    return parsed;
  }

  watchStatus() {
    return this.json<Record<string, unknown>>("aacp-watch.mjs", ["status"], { allowFail: true });
  }

  async ensureRuntimeToken(): Promise<void> {
    await this.withSession(() => this.json("a2a-runtime.mjs", ["token"]));
  }

  async reply(conversationId: string, text: string, clientMessageId?: string): Promise<unknown> {
    const args = ["reply", "--conversation", conversationId, "--text", text];
    if (clientMessageId) args.push("--client-msg", clientMessageId);
    try {
      return await this.json("a2a-runtime.mjs", args);
    } catch (err) {
      // Runtime token may have expired (12 h); refresh once and retry.
      if (/token|401|UNAUTHORIZED/i.test(String(err))) {
        await this.ensureRuntimeToken();
        return await this.json("a2a-runtime.mjs", args);
      }
      throw err;
    }
  }

  async signal(conversationId: string): Promise<void> {
    try {
      await this.node("a2a-runtime.mjs", ["signal", "--conversation", conversationId], { timeoutMs: 30_000 });
    } catch {
      /* documented as fire-and-forget */
    }
  }

  async hostingOff(agentId: string): Promise<void> {
    await this.node("a2a-runtime.mjs", ["hosting", "off", "--agent", agentId], { timeoutMs: 60_000 });
  }

  agentCard(agentId: string) {
    return this.json<{ status?: string; [k: string]: unknown }>("aacp-get.mjs", [`/api/v1/a2a/agents/${agentId}/card`], {
      allowFail: true,
    });
  }

  // ─── on-chain ──────────────────────────────────────────────────────

  /**
   * Execute a tx-intent: key mode signs locally with WALLET_KEY and broadcasts (`--yes`).
   */
  async tx(intent: TxIntent | TxIntent[], context?: Record<string, unknown>): Promise<TxResult> {
    await this.login();
    const args = Array.isArray(intent) ? ["--intents", JSON.stringify(intent)] : ["--intent", JSON.stringify(intent)];
    args.push("--yes");
    if (context) args.push("--context", JSON.stringify(context));
    const onStderr = (s: string) => {
      for (const line of s.split("\n")) if (line.trim()) this.log.debug(line.trim());
    };
    const res = await this.node("aacp-tx.mjs", args, { timeoutMs: 20 * 60 * 1000, onStderr });
    const parsed = lastJson<TxResult>(res.stdout);
    if (res.code === 0 && parsed) return parsed;
    const tail = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
    // The script exits non-zero when the RPC never returns a receipt (or when we are killed while
    // waiting for one). If the raw tx was accepted by the node, it is on its way: report it as
    // pending and let the caller confirm through the backend's order status instead of failing.
    const sent = broadcastHashes(res.stderr);
    if (sent.length && !/reverted on-chain/i.test(res.stderr)) {
      this.log.warn(`tx broadcast but unconfirmed by the RPC (${res.timedOut ? "killed" : `exit ${res.code}`}): ${sent.map((s) => `${s.action}=${s.txHash}`).join(", ")}`);
      return { mode: "key", pending: true, results: sent.map((s) => ({ action: s.action, txHash: s.txHash, status: "submitted" })) };
    }
    throw new TermixError(`aacp-tx.mjs ${args[0]} failed (exit ${res.code}): ${tail}`, res);
  }

  // ─── conversations / offers ────────────────────────────────────────

  /** One conversation with its full message list (server is the source of truth, not our local log). */
  async conversation(id: string): Promise<RemoteConversation | undefined> {
    try {
      const res = await this.get<RemoteConversation | { item?: RemoteConversation; conversation?: RemoteConversation }>(`/api/v1/conversations/${id}`);
      const c = ((res as { item?: RemoteConversation }).item ?? (res as { conversation?: RemoteConversation }).conversation ?? res) as RemoteConversation;
      return c && Array.isArray(c.messages) ? c : undefined;
    } catch (err) {
      this.log.warn(`could not fetch conversation ${id}: ${String(err)}`);
      return undefined;
    }
  }

  /** All conversations this wallet takes part in (no messages, just participants + last message). */
  async conversations(): Promise<RemoteConversation[]> {
    const res = await this.get<{ items?: RemoteConversation[] } | RemoteConversation[]>("/api/v1/conversations");
    return Array.isArray(res) ? res : (res.items ?? []);
  }

  /** Send a priced quote into a conversation (off-chain; the buyer accepts and funds it at checkout). */
  async sendOffer(conversationId: string, offer: OfferInput): Promise<RemoteOffer> {
    const listingId = getConfig().agents[this.role].listingId;
    const res = await this.api<RemoteOffer | { item?: RemoteOffer; offer?: RemoteOffer }>("POST", `/api/v1/conversations/${conversationId}/offers`, {
      providerAgentId: this.agentId,
      ...(listingId ? { listingId } : {}),
      price: offer.price,
      currency: offer.currency,
      deliveryDays: offer.deliveryDays,
      scope: offer.scope,
      proofMethod: "optimistic",
      settlementType: "escrow",
      message: offer.message ?? "",
      validUntilHours: offer.validUntilHours ?? 168,
    });
    return unwrapOffer(res);
  }

  /** Replace the terms of an existing quote (new revision; the buyer accepts the latest one). */
  async reviseOffer(offerId: string, offer: Omit<OfferInput, "currency">): Promise<RemoteOffer> {
    const res = await this.api<RemoteOffer | { item?: RemoteOffer; offer?: RemoteOffer }>("POST", `/api/v1/offers/${offerId}/revisions`, {
      price: offer.price,
      deliveryDays: offer.deliveryDays,
      scope: offer.scope,
      message: offer.message ?? "",
      validUntilHours: offer.validUntilHours ?? 168,
    });
    return unwrapOffer(res);
  }

  async offer(offerId: string): Promise<RemoteOffer | undefined> {
    try {
      return unwrapOffer(await this.get<RemoteOffer>(`/api/v1/offers/${offerId}`));
    } catch (err) {
      this.log.warn(`could not fetch offer ${offerId}: ${String(err)}`);
      return undefined;
    }
  }

  // ─── uploads ───────────────────────────────────────────────────────

  async upload(uploadUrl: string, file: string, contentType: string): Promise<{ ok: boolean; sha256?: string; sizeBytes?: number }> {
    const res = await this.json<{ ok: boolean; sha256?: string; sizeBytes?: number; size?: number }>("aacp-upload.mjs", [
      "--url",
      uploadUrl,
      "--file",
      file,
      "--content-type",
      contentType,
    ], { timeoutMs: 10 * 60 * 1000 });
    if (!res.ok) throw new TermixError(`upload failed: ${JSON.stringify(res)}`);
    return { ok: true, sha256: res.sha256, sizeBytes: res.sizeBytes ?? res.size };
  }
}

export interface RemoteMessage {
  id?: string;
  seq?: number;
  direction?: "in" | "out" | "event" | string;
  kind?: "TEXT" | "ATTACHMENT" | "OFFER_EVENT" | "ORDER_EVENT" | "FUNDS_EVENT" | string;
  text?: string | null;
  fromAccountId?: string | null;
  fromAgentId?: string | null;
  fromAccount?: { handle?: string; displayName?: string; walletAddress?: string } | null;
  fromAgent?: { id?: string; name?: string } | null;
  businessType?: string | null;
  businessId?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: Array<{ url?: string; s3Key?: string; contentType?: string }>;
  createdAt?: string;
}

export interface RemoteConversation {
  id: string;
  kind?: string;
  orderId?: string | null;
  participants?: Array<{ accountId?: string; agentId?: string | null; role?: string; account?: { handle?: string; displayName?: string; walletAddress?: string } }>;
  messages?: RemoteMessage[];
  lastMessage?: RemoteMessage | null;
  updatedAt?: string;
}

export interface OfferInput {
  price: string;
  currency: string;
  deliveryDays: number;
  scope: string;
  message?: string;
  validUntilHours?: number;
}

export interface RemoteOffer {
  id: string;
  conversationId?: string;
  status?: string;
  orderId?: string | null;
  currentRevisionId?: string;
  current?: { id: string; version?: number; price?: string; currency?: string; scope?: string; deliveryDays?: number; status?: string };
  [k: string]: unknown;
}

function unwrapOffer(res: unknown): RemoteOffer {
  const r = res as { item?: RemoteOffer; offer?: RemoteOffer; id?: string };
  const o = (r.item ?? r.offer ?? r) as RemoteOffer;
  if (!o || !o.id) throw new TermixError(`offer response carries no id: ${JSON.stringify(res).slice(0, 300)}`);
  return o;
}

const clients = new Map<Role, TermixClient>();
export function termix(role: Role): TermixClient {
  let c = clients.get(role);
  if (!c) clients.set(role, (c = new TermixClient(role)));
  return c;
}
