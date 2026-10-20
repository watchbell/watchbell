import type { ChatTurn } from "@/private/ui/deps-types";

// What the Playground may send (pure validation). Nothing here is stored; the limits only keep one request small.
export const PLAYGROUND_LIMITS = { turns: 20, turnChars: 8000, totalChars: 40_000, systemChars: 4000, maxTokensMin: 16, maxTokensMax: 8192 } as const;
export const DEFAULT_SYSTEM = "You are Watchbell's assistant. Answer from the console data you are given. Say when the data doesn't cover the question.";

export type PlaygroundInput = {
  model: string; mode: "plain" | "console"; temperature: number; maxTokens: number; system: string; messages: ChatTurn[];
};
export type ParsedPlayground = { ok: true; value: PlaygroundInput } | { ok: false; error: string };

const BAD = (error: string): ParsedPlayground => ({ ok: false, error });

export function parsePlayground(raw: unknown): ParsedPlayground {
  if (!raw || typeof raw !== "object") return BAD("Something in that request wasn't valid.");
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "console" ? "console" : r.mode === "plain" ? "plain" : null;
  if (!mode) return BAD("Pick Plain model or Ask the console.");
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (model.length > 200) return BAD("Something in that request wasn't valid.");
  const t = typeof r.temperature === "number" ? r.temperature : Number(r.temperature);
  if (!Number.isFinite(t) || t < 0 || t > 2) return BAD("Temperature is a number from 0 to 2.");
  const m = typeof r.maxTokens === "number" ? r.maxTokens : Number(r.maxTokens);
  if (!Number.isInteger(m) || m < PLAYGROUND_LIMITS.maxTokensMin || m > PLAYGROUND_LIMITS.maxTokensMax) return BAD(`Max output tokens is a whole number from ${PLAYGROUND_LIMITS.maxTokensMin} to ${PLAYGROUND_LIMITS.maxTokensMax.toLocaleString("en-US")}.`);
  const system = typeof r.system === "string" ? r.system : "";
  if (system.length > PLAYGROUND_LIMITS.systemChars) return BAD(`The system prompt is at most ${PLAYGROUND_LIMITS.systemChars.toLocaleString("en-US")} characters.`);
  if (!Array.isArray(r.messages) || r.messages.length < 1 || r.messages.length > PLAYGROUND_LIMITS.turns) return BAD(`A conversation is 1 to ${PLAYGROUND_LIMITS.turns} messages. Clear it to start over.`);
  const messages: ChatTurn[] = [];
  let total = 0;
  for (const x of r.messages) {
    const o = (x ?? {}) as Record<string, unknown>;
    if ((o.role !== "user" && o.role !== "assistant") || typeof o.content !== "string" || !o.content.trim()) return BAD("Something in that request wasn't valid.");
    if (o.content.length > PLAYGROUND_LIMITS.turnChars) return BAD(`A message is at most ${PLAYGROUND_LIMITS.turnChars.toLocaleString("en-US")} characters.`);
    total += o.content.length;
    messages.push({ role: o.role, content: o.content });
  }
  if (total > PLAYGROUND_LIMITS.totalChars) return BAD("The conversation is too long. Clear it to start over.");
  if (messages[messages.length - 1].role !== "user") return BAD("The last message must be yours.");
  return { ok: true, value: { model, mode, temperature: t, maxTokens: m, system, messages } };
}

// An error message that is safe to show: short, plain, and without anything that looks like a key or a token.
export function safeMessage(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message.trim() : "";
  if (!m || m.length > 220 || /w[bp]_|AIza|AQ\.|Bearer|sk-|gsk_|postgres|:\/\/|@/.test(m)) return fallback;
  return m;
}
