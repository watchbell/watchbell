"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { ASSIST_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { AI_LIMIT } from "./limits";
import { ports } from "./ports";
import { antigravityQuestion, whyPrompt } from "./prompts";
import { checkQuestion } from "./question-input";
import { chooseAskPath } from "./ask-path";
import { answerWithProvider, loadAskContext, WATCHPOST_CLIENT } from "./provider-answer";
import { enqueue, questionForOwner, storeAnswered } from "./questions-db";
import { refreshSummary } from "./summary";

// Owner-only Server Actions of the monitoring integration (R2): Ask AI in the Why dialog and the summary's Regenerate.
// 20 calls per 10 minutes per member. Ask (general or from the Why dialog) stores the question with its answer in ops.ai_questions; "Ask Antigravity" stores the
// scrubbed question in ops.ai_questions (the inbox) and nothing else.
const INVALID = { ok: false, error: "Something in that request wasn't valid." } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Answer = { text: string; model: string; ms: number };

async function overQuota(memberId: string): Promise<string | null> {
  const q = await limit(AI_LIMIT, memberId);
  return q.allowed ? null : `Too many AI requests. Try again in ${minutesText(q.retryAfter)}.`;
}

// The gateway's own errors carry curated messages (no keys, no upstream bodies). Anything else is generic.
function safeError(e: unknown): string {
  return e instanceof Error && e.name === "GatewayError" ? e.message.slice(0, 300) : "The AI provider couldn't answer. Try again.";
}

export async function askWhy(appId: string): Promise<ActionResult<Answer>> {
  return runGuarded("owner", async (member): Promise<ActionResult<Answer>> => {
    if (typeof appId !== "string" || !UUID.test(appId)) return INVALID;
    const over = await overQuota(member.id);
    if (over) return { ok: false, error: over };
    if (!(await ports.provider())) return { ok: false, error: ASSIST_COPY.noProvider };
    const app = await ports.appSnapshot(appId, new Date());
    if (!app) return { ok: false, error: "That application wasn't found." };
    try {
      const r = await ports.complete(whyPrompt(app), { purpose: "ask-ai", maxTokens: 500 });
      const text = r.text.trim();
      if (!text) return { ok: false, error: "The model returned no text. Try again." };
      return { ok: true, data: { text, model: r.model, ms: r.ms } };
    } catch (e) {
      return { ok: false, error: safeError(e) };
    }
  }, { requireActionMember }, "local");
}

// The Why dialog's Ask button. Antigravity connected (a report within 24 h from an active key): the question goes to
// its inbox as before. Otherwise (owner 14 Oct) the owner's provider answers right away and the answered question is
// stored, so AI › Ask keeps the history; a provider failure stores nothing.
export type AskAnswer = { id: string; status: "answered" | "pending"; text?: string; model?: string; ms?: number };

export async function askAntigravity(appId: string): Promise<ActionResult<AskAnswer>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AskAnswer>> => {
    if (typeof appId !== "string" || !UUID.test(appId)) return INVALID;
    const over = await overQuota(member.id);
    if (over) return { ok: false, error: over };
    const now = new Date();
    const app = await ports.appSnapshot(appId, now);
    if (!app) return { ok: false, error: "That application wasn't found." };
    const question = antigravityQuestion(app);
    const ctx = await loadAskContext(now);
    if (!ctx.agConnected) {
      if (!ctx.providerReady) return { ok: false, error: "No AI provider is connected. Connect one under AI Gateway › Bring your own key." };
      return answerAndStore({ kind: "app", contextId: appId, question, by: member.userId, askedAt: now });
    }
    const r = await enqueue({ kind: "app", contextId: appId, question, by: member.userId, now });
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.reused) {
      try {
        await recordAction({ kind: "ok", message: ASSIST_COPY.queuedAudit(app.id.slice(0, 80)), resourceId: appId, actorUserId: member.userId });
      } catch {
        console.warn("audit event failed");
      }
    }
    refresh();
    return { ok: true, message: r.reused ? ASSIST_COPY.alreadyWaiting : ASSIST_COPY.sentApp, data: { id: r.id, status: "pending" } };
  }, { requireActionMember });
}

// One provider answer, then the answered row. Nothing is stored when the provider fails.
async function answerAndStore(a: { kind: "app" | "general"; contextId: string | null; question: string; by: string; askedAt: Date; model?: string }): Promise<ActionResult<AskAnswer>> {
  let r;
  try {
    r = await answerWithProvider(a.question, { model: a.model, now: a.askedAt });
  } catch (e) {
    console.warn("ask: provider failed:", e instanceof Error ? e.name : "unknown");
    return { ok: false, error: safeError(e) };
  }
  const stored = await storeAnswered({
    kind: a.kind, contextId: a.contextId, question: a.question, by: a.by, askedAt: a.askedAt, answeredAt: new Date(), answer: r.text, client: WATCHPOST_CLIENT, model: r.model,
  });
  refresh();
  return { ok: true, message: `Answered by ${r.model} in ${(r.ms / 1000).toFixed(1)} s.`, data: { id: stored.id, status: "answered", text: r.text, model: r.model, ms: r.ms } };
}

// AI › Ask: a free question, not tied to an app (kind "general"). The owner's own words are stored as typed
// (trimmed); text that looks like a key or token is refused, never stored. `model` (chooseAskPath): empty = Default
// (the default provider's default model), a provider model id ("test/prrojects") = that model, both answered right
// away and stored answered; "ag/<id>" = Antigravity's inbox, only while Antigravity is connected and that model is on.
export async function askGeneral(question: string, model?: string | null): Promise<ActionResult<AskAnswer>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AskAnswer>> => {
    const checked = checkQuestion(question);
    if (!checked.ok) return { ok: false, error: checked.error };
    const now = new Date();
    const path = chooseAskPath(model, await loadAskContext(now));
    if (path.via === "none") return { ok: false, error: path.error };
    const over = await overQuota(member.id);
    if (over) return { ok: false, error: over };
    if (path.via === "provider") return answerAndStore({ kind: "general", contextId: null, question: checked.question, by: member.userId, askedAt: now, model: path.model });
    const picked = path.model;
    const r = await enqueue({ kind: "general", contextId: null, question: checked.question, by: member.userId, now, model: picked });
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.reused) {
      try {
        await recordAction({ kind: "ok", message: ASSIST_COPY.queuedAudit("general"), resourceId: null, actorUserId: member.userId });
      } catch {
        console.warn("audit event failed");
      }
    }
    refresh();
    return { ok: true, message: r.reused ? ASSIST_COPY.alreadyWaiting : ASSIST_COPY.sentGeneral, data: { id: r.id, status: "pending" } };
  }, { requireActionMember });
}

// AI › Playground: the status of one question it sent with askGeneral, polled every 3 s while it waits. Owner only, by
// id, the member's own "ask" questions only (pings and other members' questions read as not found). A read, so it
// doesn't count toward the AI quota. answeredAt is ISO text (plain data for the browser).
export type QuestionPoll = { status: "pending" | "answered" | "expired"; answer: string | null; model: string | null; answeredAt: string | null };

export async function questionStatus(id: string): Promise<ActionResult<QuestionPoll>> {
  return runGuarded("owner", async (member): Promise<ActionResult<QuestionPoll>> => {
    if (typeof id !== "string" || !UUID.test(id)) return INVALID;
    const q = await questionForOwner(id, member.userId, new Date());
    if (!q) return { ok: false, error: "That question wasn't found. It may have been cleaned up." };
    return { ok: true, data: { status: q.status, answer: q.answer, model: q.model ?? q.requestedModel, answeredAt: q.answeredAt ? q.answeredAt.toISOString() : null } };
  }, { requireActionMember });
}

export async function regenerateSummary(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const over = await overQuota(member.id);
    if (over) return { ok: false, error: over };
    try {
      const r = await refreshSummary(new Date(), { force: true });
      if (r.status === "no-provider") return { ok: false, error: "No AI provider is connected." };
      if (r.status === "empty") return { ok: false, error: "There are no recommendations to summarise." };
    } catch (e) {
      return { ok: false, error: safeError(e) };
    }
    refresh();
    return { ok: true, message: "Summary updated." };
  }, { requireActionMember });
}
