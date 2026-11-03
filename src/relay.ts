import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * The cun.ai relay (OpenAI-compatible, New API): chat completions for every model on its
 * catalog (Claude included) and the OpenAI Images API for gpt-image-*. One key for both.
 */

const log = logger("relay");

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

function key(): string {
  const k = getConfig().relay.apiKey;
  if (!k) throw new Error("RELAY_API_KEY is not set in .env.local");
  return k;
}

function ledger(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(path.join(getConfig().dataDir, "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* best effort */
  }
}

async function post(pathname: string, body: unknown, timeoutMs: number, tag: string): Promise<Record<string, unknown>> {
  const { baseUrl } = getConfig().relay;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        // 524 / 5xx from Cloudflare in front of the relay are transient; 4xx are not.
        if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        throw Object.assign(new Error(`${tag}: HTTP ${res.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`), { fatal: true });
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) throw err;
      log.warn(`${tag}: attempt ${attempt} failed: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw lastErr;
}

export async function chat(messages: ChatMessage[], opts: { model?: string; maxTokens?: number; tag?: string; temperature?: number } = {}): Promise<string> {
  const model = opts.model ?? getConfig().relay.chatModel;
  const res = await post(
    "/v1/chat/completions",
    { model, messages, max_tokens: opts.maxTokens ?? 4000, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) },
    300_000,
    `chat ${model}`,
  );
  const choice = (res.choices as Array<{ message?: { content?: string } }> | undefined)?.[0];
  const usage = res.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  ledger({ kind: "chat", tag: opts.tag, model, input: usage?.prompt_tokens, output: usage?.completion_tokens });
  return (choice?.message?.content ?? "").trim();
}

/** Parse the first JSON object/array in a model reply (tolerates ```json fences and prose around it). */
export function parseJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  for (let end = body.lastIndexOf(close); end > start; end = body.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(body.slice(start, end + 1)) as T;
    } catch {
      /* try a shorter slice */
    }
  }
  throw new Error(`unparseable JSON in model reply: ${text.slice(0, 300)}`);
}

/** Ask for JSON and parse it; one repair round if the first reply does not parse. */
export async function chatJson<T>(messages: ChatMessage[], opts: { model?: string; maxTokens?: number; tag?: string } = {}): Promise<T> {
  const first = await chat(messages, { ...opts, model: opts.model ?? getConfig().relay.planModel });
  try {
    return parseJson<T>(first);
  } catch (err) {
    log.warn(`${opts.tag ?? "chatJson"}: reply was not valid JSON, asking once more (${String(err).slice(0, 120)})`);
    const again = await chat([...messages, { role: "assistant", content: first }, { role: "user", content: "That was not valid JSON. Reply with the JSON only." }], {
      ...opts,
      model: opts.model ?? getConfig().relay.planModel,
    });
    return parseJson<T>(again);
  }
}

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

/**
 * gpt-image-2 via the relay. With reference images the edits endpoint is used (identity
 * references for characters); without, plain generations.
 */
export async function generateImage(input: { prompt: string; outPath: string; size?: ImageSize; refs?: string[]; quality?: "low" | "medium" | "high"; tag?: string }): Promise<string> {
  const cfg = getConfig();
  const model = cfg.relay.imageModel;
  const common = { model, prompt: input.prompt, size: input.size ?? "1536x1024", n: 1, quality: input.quality ?? "high" };
  let res: Record<string, unknown> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3 && !res; attempt++) {
    try {
      if (input.refs?.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(common)) form.set(k, String(v));
        for (const r of input.refs) form.append("image[]", new Blob([fs.readFileSync(r)], { type: "image/png" }), path.basename(r));
        const r = await fetch(`${cfg.relay.baseUrl}/v1/images/edits`, { method: "POST", headers: { authorization: `Bearer ${key()}` }, body: form, signal: AbortSignal.timeout(600_000) });
        const text = await r.text();
        if (!r.ok) throw new Error(`images/edits HTTP ${r.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
        res = JSON.parse(text) as Record<string, unknown>;
      } else {
        res = await post("/v1/images/generations", { ...common, output_format: "png" }, 600_000, `image ${model}`);
      }
    } catch (err) {
      lastErr = err;
      log.warn(`image ${input.tag ?? path.basename(input.outPath)}: attempt ${attempt} failed: ${String(err).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const item = (res.data as Array<{ b64_json?: string; url?: string }> | undefined)?.[0];
  const buf = item?.b64_json ? Buffer.from(item.b64_json, "base64") : item?.url ? Buffer.from(await (await fetch(item.url)).arrayBuffer()) : undefined;
  if (!buf) throw new Error(`image response carries no data: ${JSON.stringify(res).slice(0, 200)}`);
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  fs.writeFileSync(input.outPath, buf);
  ledger({ kind: "image", tag: input.tag, model, size: common.size, refs: input.refs?.length ?? 0 });
  return input.outPath;
}

/** Remaining quota and month-to-date spend of the relay key (OpenAI-compatible billing endpoints). */
export async function relayBalance(): Promise<{ usedUsd?: number; limitUsd?: number }> {
  const { baseUrl } = getConfig().relay;
  const headers = { authorization: `Bearer ${key()}` };
  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 86400_000).toISOString().slice(0, 10);
  const [u, s] = await Promise.all([
    fetch(`${baseUrl}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`, { headers, signal: AbortSignal.timeout(20_000) }).then((r) => r.json() as Promise<{ total_usage?: number }>),
    fetch(`${baseUrl}/v1/dashboard/billing/subscription`, { headers, signal: AbortSignal.timeout(20_000) }).then((r) => r.json() as Promise<{ hard_limit_usd?: number }>),
  ]);
  return { usedUsd: u.total_usage !== undefined ? u.total_usage / 100 : undefined, limitUsd: s.hard_limit_usd };
}
