import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { ASSIST_COPY } from "@/lib/copy/edition";
import { alerts, resources } from "@/db/schema";
import { type AliasBook, hideAlert } from "@/lib/view/display-name";
import { aiQuestions } from "@/private/db/schema";
import { PING_QUESTION, PING_TIMEOUT_MS } from "@/private/ai/extras";
import type { QuestionContextKind, QuestionStatus } from "@/private/ai/types";

// The AI inbox (owner 07:35): Ask AI enqueues a row here, Antigravity answers it over MCP (Task 7), the page shows
// the answer on its normal 60 s refresh. Bounded: 7-day retention, at most MAX_PENDING waiting, one waiting
// question per app (asking again while one waits shows that one), and one waiting copy of the same general question
// from the same asker.
//
// created_by holds who asked: the member's user id from the console, the console API key's id from
// POST /api/v1/ai/questions (no FK on the column; both are random uuids). That is how a key reads back only its own
// questions (questionForKey) without a schema change.

export const QUESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 20;
export const THREAD_LIMIT = 50;

// `model` is the model that answered; `requestedModel` the Antigravity model the asker picked (null = the VM's own).
export type QuestionView = {
  id: string; status: QuestionStatus; answer: string | null; client: string | null; model: string | null; requestedModel: string | null; createdAt: Date; answeredAt: Date | null;
};

type Row = { id: string; status: QuestionStatus; answer: string | null; client: string | null; model: string | null; requestedModel: string | null; createdAt: Date; answeredAt: Date | null };

// A pending question older than the retention is shown as expired even before the daily cleanup deletes it.
export function viewOf(r: Row, now: Date): QuestionView {
  const expired = r.status === "pending" && now.getTime() - r.createdAt.getTime() > QUESTION_TTL_MS;
  return { ...r, status: expired ? "expired" : r.status };
}

const COLS = {
  id: aiQuestions.id, status: aiQuestions.status, answer: aiQuestions.answer, client: aiQuestions.answeredByClient,
  model: aiQuestions.answeredByModel, requestedModel: aiQuestions.requestedModel, createdAt: aiQuestions.createdAt, answeredAt: aiQuestions.answeredAt,
};

export async function latestFor(kind: QuestionContextKind, contextId: string, now: Date): Promise<QuestionView | null> {
  const [r] = await db().select(COLS).from(aiQuestions)
    .where(and(eq(aiQuestions.contextKind, kind), eq(aiQuestions.contextId, contextId)))
    .orderBy(desc(aiQuestions.createdAt)).limit(1);
  return r ? viewOf(r, now) : null;
}

export type Enqueued = { ok: true; id: string; reused: boolean } | { ok: false; error: string };

// `contextId` is null for a general question (Ask page, API); `by` is null only when nobody can be named. `model` is an
// Antigravity model id the caller already checked against the enabled set (null = the VM's own setting). Pings
// (Models page tests) don't count towards the 20 waiting questions and are never reused as a question.
export async function enqueue(a: { kind: QuestionContextKind; contextId: string | null; question: string; by: string | null; now: Date; model?: string | null }): Promise<Enqueued> {
  const since = new Date(a.now.getTime() - QUESTION_TTL_MS);
  const question = a.question.slice(0, 2000);
  const model = a.model ?? null;
  const waiting = await db().select({ id: aiQuestions.id, contextId: aiQuestions.contextId, question: aiQuestions.question, by: aiQuestions.createdBy, model: aiQuestions.requestedModel }).from(aiQuestions)
    .where(and(eq(aiQuestions.status, "pending"), eq(aiQuestions.purpose, "ask"), sql`${aiQuestions.createdAt} >= ${since.toISOString()}::timestamptz`))
    .limit(MAX_PENDING + 1);
  const same = a.contextId !== null
    ? waiting.find((w) => w.contextId === a.contextId)
    : waiting.find((w) => w.contextId === null && w.question === question && w.by === a.by && (w.model ?? null) === model);
  if (same) return { ok: true, id: same.id, reused: true };
  if (waiting.length >= MAX_PENDING) return { ok: false, error: ASSIST_COPY.tooMany(MAX_PENDING) };
  const [row] = await db().insert(aiQuestions)
    .values({ contextKind: a.kind, contextId: a.contextId, question, status: "pending", createdBy: a.by, createdAt: a.now, requestedModel: model, purpose: "ask" })
    .returning({ id: aiQuestions.id });
  return row ? { ok: true, id: row.id, reused: false } : { ok: false, error: "Something went wrong. Try again." };
}

// A question the owner's provider already answered (owner 14 Oct): stored answered in one insert so AI › Ask keeps
// the history. Never called before the answer exists, so a provider failure leaves no row behind.
export type AnsweredQuestion = {
  kind: QuestionContextKind; contextId: string | null; question: string; by: string | null; askedAt: Date; answeredAt: Date;
  answer: string; client: string; model: string;
};

export async function storeAnswered(a: AnsweredQuestion): Promise<{ id: string }> {
  const [row] = await db().insert(aiQuestions).values({
    contextKind: a.kind, contextId: a.contextId, question: a.question.slice(0, 2000), status: "answered", createdBy: a.by, createdAt: a.askedAt,
    answer: a.answer.slice(0, 8000), answeredByClient: a.client.slice(0, 80), answeredByModel: a.model.slice(0, 120), answeredAt: a.answeredAt,
    requestedModel: null, purpose: "ask",
  }).returning({ id: aiQuestions.id });
  if (!row) throw new Error("insert returned no row");
  return { id: row.id };
}

// ---- Models page "Test": one "ping" question per model, purpose 'ping' (hidden from the Ask page). ----

export type PingsQueued = { queued: string[]; waiting: string[] };

// A model whose ping still waits (younger than PING_TIMEOUT_MS) gets no second one. One read, one insert.
export async function enqueuePings(models: string[], by: string, now: Date): Promise<PingsQueued> {
  if (models.length === 0) return { queued: [], waiting: [] };
  const since = new Date(now.getTime() - PING_TIMEOUT_MS);
  const open = await db().select({ model: aiQuestions.requestedModel }).from(aiQuestions)
    .where(and(eq(aiQuestions.status, "pending"), eq(aiQuestions.purpose, "ping"), inArray(aiQuestions.requestedModel, models), gte(aiQuestions.createdAt, since)))
    .limit(models.length + 1);
  const busy = new Set(open.map((o) => o.model));
  const fresh = models.filter((m) => !busy.has(m));
  if (fresh.length) {
    await db().insert(aiQuestions).values(fresh.map((m) => ({
      contextKind: "general" as const, contextId: null, question: PING_QUESTION, status: "pending" as const, createdBy: by, createdAt: now, requestedModel: m, purpose: "ping" as const,
    })));
  }
  return { queued: fresh, waiting: models.filter((m) => busy.has(m)) };
}

// ---- The Ask page's thread (AI › Ask): every kind, newest first, the last 7 days, at most 50. ----

export type ThreadItem = QuestionView & {
  question: string;
  kind: QuestionContextKind;
  // What the context chip shows. app: the app's real name (the page masks it in screenshot mode, like every app name);
  // alert: the alert's title with database names aliased and emails hidden (hideAlert); general: null.
  label: string | null;
};

type ThreadRow = Row & { question: string; kind: QuestionContextKind; contextId: string | null };
type AlertRow = { id: string; title: string; message: string; causedBy: string | null; resourceId: string | null };

// Pure: the rows plus the names they point at. An app or alert that is gone since gets a plain stand-in, never its id.
export function threadView(rows: ThreadRow[], apps: { id: string; name: string }[], alertRows: AlertRow[], book: AliasBook, now: Date): ThreadItem[] {
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const alertTitle = new Map(alertRows.map((a) => [a.id, hideAlert(a, book).title]));
  return rows.map(({ contextId, ...r }) => {
    const label = r.kind === "app" ? (contextId && appName.get(contextId)) ?? "A removed app"
      : r.kind === "alert" ? (contextId && alertTitle.get(contextId)) ?? "A cleared alert"
      : null;
    return { ...viewOf(r, now), question: r.question, kind: r.kind, label };
  });
}

export async function listThread(now: Date, book: AliasBook): Promise<ThreadItem[]> {
  const since = new Date(now.getTime() - QUESTION_TTL_MS);
  const rows = await db().select({ ...COLS, question: aiQuestions.question, kind: aiQuestions.contextKind, contextId: aiQuestions.contextId })
    .from(aiQuestions).where(and(gte(aiQuestions.createdAt, since), eq(aiQuestions.purpose, "ask")))
    .orderBy(desc(aiQuestions.createdAt)).limit(THREAD_LIMIT);
  const ids = (kind: QuestionContextKind) => [...new Set(rows.filter((r) => r.kind === kind && r.contextId).map((r) => r.contextId as string))];
  const appIds = ids("app");
  const alertIds = ids("alert");
  const [apps, alertRows] = await Promise.all([
    appIds.length ? db().select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, appIds)) : Promise.resolve([]),
    alertIds.length
      ? db().select({ id: alerts.id, title: alerts.title, message: alerts.message, causedBy: alerts.causedBy, resourceId: alerts.resourceId }).from(alerts).where(inArray(alerts.id, alertIds))
      : Promise.resolve([]),
  ]);
  return threadView(rows, apps, alertRows, book, now);
}

// ---- GET /api/v1/ai/questions/{id}: a key reads only the questions it asked, for 7 days. ----

export type KeyQuestion = QuestionView & { question: string };

export async function questionForKey(id: string, keyId: string, now: Date): Promise<KeyQuestion | null> {
  const since = new Date(now.getTime() - QUESTION_TTL_MS);
  const [r] = await db().select({ ...COLS, question: aiQuestions.question }).from(aiQuestions)
    .where(and(eq(aiQuestions.id, id), eq(aiQuestions.createdBy, keyId), eq(aiQuestions.contextKind, "general"), eq(aiQuestions.purpose, "ask"), gte(aiQuestions.createdAt, since)))
    .limit(1);
  return r ? { ...viewOf(r, now), question: r.question } : null;
}

// ---- The Playground's status poll: one "ask" question by id, only the member's own (never a ping). ----

// No 7-day filter: a pending row past the retention reads as expired (viewOf) until the daily cleanup deletes it.
export async function questionForOwner(id: string, by: string, now: Date): Promise<QuestionView | null> {
  const [r] = await db().select(COLS).from(aiQuestions)
    .where(and(eq(aiQuestions.id, id), eq(aiQuestions.createdBy, by), eq(aiQuestions.purpose, "ask")))
    .limit(1);
  return r ? viewOf(r, now) : null;
}
