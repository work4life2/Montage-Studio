import { logger } from "../log.js";
import { accessToken, PROVIDERS, type ProviderId } from "./oauth.js";

const log = logger("mcp");
const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
  [k: string]: unknown;
}

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class McpError extends Error {}

/** One JSON-RPC message out of a JSON or text/event-stream response body. */
function pickMessage(body: string, contentType: string, id: number): Record<string, unknown> | undefined {
  const parse = (s: string) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  if (!contentType.includes("text/event-stream")) return parse(body);
  let found: Record<string, unknown> | undefined;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    const msg = data && parse(data);
    if (msg && msg.id === id) found = msg;
  }
  return found;
}

/**
 * Minimal MCP client over the Streamable HTTP transport, authenticated with the stored OAuth
 * grant. Tool calls are plain request/response; long jobs (renders, songs) are polled by the
 * caller through the provider's own status tools.
 */
export class McpClient {
  private sessionId: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;
  private tools: McpTool[] | undefined;

  constructor(readonly provider: ProviderId) {}

  get url(): string {
    return PROVIDERS[this.provider].mcpUrl;
  }

  private async post(payload: Record<string, unknown>, opts: { timeoutMs?: number; retried?: boolean } = {}): Promise<Record<string, unknown> | undefined> {
    const token = await accessToken(this.provider, { force: opts.retried === true });
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401 && !opts.retried) return this.post(payload, { ...opts, retried: true });
    if (res.status === 404 && this.sessionId && payload.method !== "initialize" && !opts.retried) {
      // Session expired on the server: start a new one and resend.
      this.sessionId = undefined;
      this.initialized = undefined;
      await this.init();
      return this.post(payload, { ...opts, retried: true });
    }
    const body = await res.text();
    if (payload.id === undefined) return undefined; // notification
    if (!res.ok) throw new McpError(`${PROVIDERS[this.provider].label} MCP HTTP ${res.status}: ${body.slice(0, 400)}`);
    const msg = pickMessage(body, res.headers.get("content-type") ?? "", payload.id as number);
    if (!msg) throw new McpError(`${PROVIDERS[this.provider].label} MCP: no response for request ${String(payload.id)}: ${body.slice(0, 300)}`);
    if (msg.error) throw new McpError(`${PROVIDERS[this.provider].label} MCP error: ${JSON.stringify(msg.error).slice(0, 600)}`);
    return msg.result as Record<string, unknown>;
  }

  private async request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (method !== "initialize") await this.init();
    const id = this.nextId++;
    return (await this.post({ jsonrpc: "2.0", id, method, params }, { timeoutMs })) ?? {};
  }

  init(): Promise<void> {
    this.initialized ??= (async () => {
      const r = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "montage-studio", version: "0.1.0" },
      });
      log.debug(`${this.provider}: initialized`, { server: r.serverInfo, protocol: r.protocolVersion });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((e) => {
      this.initialized = undefined;
      throw e;
    });
    return this.initialized;
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...((r.tools as McpTool[]) ?? []));
      cursor = r.nextCursor as string | undefined;
    } while (cursor);
    this.tools = out;
    return out;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 300_000): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult;
    if (r.isError) throw new McpError(`${PROVIDERS[this.provider].label} ${name} failed: ${textOf(r).slice(0, 800)}`);
    return r;
  }
}

/** Concatenated text content of a tool result. */
export function textOf(r: McpCallResult): string {
  return (r.content ?? [])
    .map((c) => c.text ?? c.resource?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Structured payload of a tool result: structuredContent, else the first text block that parses as JSON. */
export function jsonOf<T = Record<string, unknown>>(r: McpCallResult): T | undefined {
  if (r.structuredContent) return r.structuredContent as T;
  for (const c of r.content ?? []) {
    const t = c.text ?? c.resource?.text;
    if (!t) continue;
    try {
      return JSON.parse(t) as T;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

const clients = new Map<ProviderId, McpClient>();
export function mcp(p: ProviderId): McpClient {
  let c = clients.get(p);
  if (!c) clients.set(p, (c = new McpClient(p)));
  return c;
}
