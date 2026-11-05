/**
 * Termix is agent-to-agent, so the other side of a chat may be another AI agent.
 * Two "always answer" agents once replied to each other without end (Montage
 * Studio ↔ Jev FC Buddy, ~90 messages, 2026-11-05). The watcher's chat.message
 * event carries the backend's `conversationKind`, `myRole` (CLIENT = we started
 * this conversation with a seller), `fromAutomated` (sent by another agent's
 * software), `businessActive` (a quote or order in progress) and, in team
 * channels, `mentionsMe`; these rules turn them into "do not answer":
 *   - an ORDER_TEAM channel (sub-task group chat) is answered only when we are
 *     @-mentioned, with none of the rules below;
 *   - never answer where we are the client;
 *   - to automated senders the model may answer NO_REPLY when a reply adds nothing;
 *   - backstop for automated senders: no reply to a repeat of their previous
 *     message, and — unless business is in progress — at most BOT_REPLY_BUDGET
 *     of our messages per conversation per rolling window.
 * A person (fromAutomated false, or a backend too old to say) always gets an answer.
 */
export const NO_REPLY = "[NO_REPLY]";
export const BOT_REPLY_BUDGET = 20;
export const BOT_REPLY_WINDOW_MS = 10 * 60 * 1000;

/** Prompt line added when the sender is another agent's software. */
export const NO_REPLY_RULE =
  `The latest message was sent by another AI agent's software, not typed by a person. Not every message needs an answer: ` +
  `reply with exactly ${NO_REPLY} and nothing else when replying adds nothing — small talk or greetings, thanks or goodbyes, ` +
  `a sales pitch for their own service, a repeat of something already said, or a conversation that is going in circles. ` +
  `Answer only a real request for our service (a question, a quote, an order).`;

export interface ChatSignals {
  conversationKind?: unknown;
  myRole?: unknown;
  fromAutomated?: unknown;
  businessActive?: unknown;
  mentionsMe?: unknown;
}

/** One entry of the local conversation log: "buyer" = the other side, "agent" = us. */
export interface LoggedMessage {
  role: string;
  text: string;
  at: string;
}

export function fromBot(ev: ChatSignals): boolean {
  return ev.fromAutomated === true;
}

/** NO_REPLY is offered to another agent's software in a one-to-one chat, never to a person or a team-channel @-mention. */
export function mayStaySilent(ev: ChatSignals): boolean {
  return fromBot(ev) && ev.conversationKind !== "ORDER_TEAM";
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Why not to call the model at all, or null to go ahead. `log` already ends with
 * the inbound message being handled.
 */
export function skipReason(ev: ChatSignals, log: LoggedMessage[], now = Date.now()): string | null {
  if (ev.conversationKind === "ORDER_TEAM") return ev.mentionsMe === true ? null : "team channel message that does not @-mention us";
  if (ev.myRole === "CLIENT") return "we started this conversation (client side)";
  if (!fromBot(ev)) return null;
  const theirs = log.filter((m) => m.role === "buyer");
  const current = theirs.at(-1);
  const previous = theirs.at(-2);
  if (current && previous && norm(current.text) && norm(current.text) === norm(previous.text)) return "repeat of their previous message";
  if (ev.businessActive === true) return null;
  const recent = log.filter((m) => m.role === "agent" && now - Date.parse(m.at) < BOT_REPLY_WINDOW_MS).length;
  if (recent >= BOT_REPLY_BUDGET) return `reply budget spent (${BOT_REPLY_BUDGET} per ${BOT_REPLY_WINDOW_MS / 60_000} min to automated senders)`;
  return null;
}

/** The model's raw output with NO_REPLY handled: null = send nothing (only ever for a bot). */
export function replyOrSilence(raw: string, ev: ChatSignals): string | null {
  if (!raw.includes(NO_REPLY)) return raw;
  if (mayStaySilent(ev)) return null;
  return raw.split(NO_REPLY).join("").trim();
}
