// ──────────────────────────────────────────────────────────
// LLM access — one implementation, shared by every script
// ──────────────────────────────────────────────────────────
//
// This is a MODULE, not a command. The host agent already has its own model;
// what it cannot do is think inside a detached background worker. These helpers
// exist for the loops (`aacp-autopilot.mjs`, `aacp-quant.mjs autotrade`) that
// keep running after the conversation has moved on and still have to decide
// whether to quote a request, whether to trade, and what went wrong when a tick
// fails.
//
// Any OpenAI-compatible endpoint works. The env names are the ones `autoreply`
// already documented, so an operator who configured that gets these for free:
//
//   OPENROUTER_API_KEY | OPENAI_API_KEY   the key (either name)
//   OPENAI_BASE_URL                       default https://openrouter.ai/api/v1
//   A2A_LLM_MODEL                         default openai/gpt-4o-mini
//
// Zero dependencies, no side effects on import (house style for this skill).

export function llmConfig() {
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const base = (process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.A2A_LLM_MODEL || "openai/gpt-4o-mini";
  return { key, base, model };
}

/**
 * Whether a model is reachable at all.
 *
 * Callers that are about to detach a background worker MUST check this first:
 * a worker that discovers the missing key after forking leaves the operator
 * with a silently dead process and a "started" message.
 */
export function llmConfigured() {
  return Boolean(llmConfig().key);
}

function noKey() {
  return new Error(
    "No LLM key — set OPENROUTER_API_KEY (or OPENAI_API_KEY). The autonomous loops need a model to decide with.",
  );
}

async function chatCompletion(messages, { temperature = 0.4, maxTokens = 600, responseFormat } = {}) {
  const { key, base, model } = llmConfig();
  if (!key) throw noKey();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned an empty reply");
  return text;
}

/** Plain-text completion. Used by `autoreply` to draft a message to a buyer. */
export async function llmChat({ system, user, temperature, maxTokens } = {}) {
  return chatCompletion(
    [
      { role: "system", content: system ?? "" },
      { role: "user", content: user ?? "" },
    ],
    { temperature, maxTokens },
  );
}

// Models wrap JSON in prose or fences often enough that trusting the raw body
// would fail on a good answer. Pull the outermost object out instead.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * A decision, as a validated object.
 *
 * `schemaHint` is the shape the caller wants, written out for the model. There
 * is exactly one retry, and a second failure throws: a decision path must not
 * proceed on half a parse. Whatever comes back is still the model's word — the
 * CALLER is responsible for range-checking every field against its policy
 * before acting on it. Nothing here is a safety boundary.
 */
export async function llmJson({ system, user, schemaHint, temperature = 0.2, maxTokens = 700 } = {}) {
  const instruction =
    `${system ?? ""}\n\nReply with ONE JSON object and nothing else. Shape:\n${schemaHint ?? "{}"}`.trim();
  const messages = [
    { role: "system", content: instruction },
    { role: "user", content: user ?? "" },
  ];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await chatCompletion(messages, {
      temperature,
      maxTokens,
      // Honoured by OpenAI-compatible providers that support it; harmlessly
      // ignored by the ones that don't, which is why extractJson still runs.
      responseFormat: { type: "json_object" },
    });
    try {
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: "That was not parseable JSON. Reply with the JSON object only." });
    }
  }
  throw new Error(`LLM did not return usable JSON: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/**
 * One sentence about why a tick failed, for the worker's log.
 *
 * This is the "call the model when something goes wrong" path. It is
 * best-effort by construction: a background loop must not die because its
 * diagnostician was unreachable, so every failure here degrades to the raw
 * error text. It never touches the network on the caller's behalf and never
 * retries the failed operation — it only explains.
 */
export async function llmDiagnose(error, context = "") {
  const message = error instanceof Error ? error.message : String(error);
  if (!llmConfigured()) return message;
  try {
    const text = await chatCompletion(
      [
        {
          role: "system",
          content:
            "You diagnose failures in a Termix marketplace agent worker. Answer in at most two sentences: " +
            "the likely cause, and the one thing the operator should check. No apologies, no preamble.",
        },
        { role: "user", content: `Context: ${context}\nError: ${message}` },
      ],
      { temperature: 0.2, maxTokens: 160 },
    );
    return `${message} — ${text}`;
  } catch {
    return message;
  }
}
