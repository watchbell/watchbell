import "server-only";
import { enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { complete, consoleTarget } from "@/private/ai/gateway";
import { consoleSnapshot } from "@/private/console/snapshot";
import type { AskContext } from "./ask-path";
import { consoleChatPrompt, guard } from "./prompts";

// Owner decision 14 Oct 00:05 WIB: the console's AI answers through the owner's own provider connection ("Bring your
// own key"); Antigravity over MCP is optional and never the path anything waits on. answerWithProvider is the ONE
// place Ask (AI › Ask, the Why dialog) and POST /api/v1/ai/questions get a provider answer: the scrubbed console
// snapshot (the same builder as the Playground's console mode, through consoleChatPrompt's guard) plus the question,
// one gateway call. The gateway records the call as kind 'console' (no prompt or answer stored there) and throws a
// GatewayError with a curated message on failure.

export const ANSWER_MAX = 8000; // ops.ai_questions.answer check
export const CONTEXT_MAX = 2000;
export const WATCHPOST_CLIENT = "watchpost";

export type ProviderAnswer = { text: string; model: string; ms: number };

export async function answerWithProvider(question: string, opts: { model?: string; context?: string; contextMax?: number; now?: Date } = {}): Promise<ProviderAnswer> {
  const now = opts.now ?? new Date();
  const messages = consoleChatPrompt(await consoleSnapshot(now), question);
  if (opts.context) {
    const user = messages[messages.length - 1];
    user.content = `${user.content}\n\nContext: ${guard(opts.context, Math.min(opts.contextMax ?? CONTEXT_MAX, 4000))}`;
  }
  const r = await complete(messages, { ...(opts.model ? { model: opts.model } : {}), purpose: "console-chat", maxTokens: 1500 });
  const text = r.text.trim();
  if (!text) throw new EmptyAnswerError();
  return { text: text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX - 1)}…` : text, model: r.model, ms: r.ms };
}

// An empty completion is a failure (nothing is stored); the message is safe to show.
export class EmptyAnswerError extends Error {
  constructor() {
    super("The model returned no text. Try again.");
    this.name = "GatewayError";
  }
}

// The live context: Antigravity's report and the owner's switches (a failed read = not connected) and whether the
// default provider route resolves (consoleTarget, from the 60 s connection cache; no upstream call).
export async function loadAskContext(now: Date = new Date()): Promise<AskContext> {
  const [ag, providerReady] = await Promise.all([
    readAgSettings(now).catch(() => null),
    consoleTarget().then(() => true, () => false),
  ]);
  const agConnected = !!ag && isFresh(ag.report, now);
  return { agConnected, agEnabled: agConnected && ag ? enabledModels(ag.report, ag.prefs, ag.allowed) : [], providerReady };
}
