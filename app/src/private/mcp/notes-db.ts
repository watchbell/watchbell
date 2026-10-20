import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { settings } from "@/db/schema";
import { AI_ALLOWED_MODELS_SETTING, type NoteSeverity, type QuestionContextKind } from "@/private/ai/types";
import { MCP_ALLOWED_MODELS } from "./scrub";

// The MCP write tools' storage (R8): AI notes (submit_ai_note) and answers to the AI inbox (answer_question). Each
// write is ONE statement that also counts the key's hourly budget in ops.rate_limits, so a looping agent can't turn
// into unbounded writes; a rejected write inserts nothing.

export const NOTES_KEEP = 200; // newest rows kept (R8)
export const NOTES_PER_HOUR = 20; // per key (R8)
export const ANSWERS_PER_HOUR = 60; // per key
export const NOTES_RETENTION_DAYS = 30;
export const QUESTIONS_RETENTION_DAYS = 7; // owner ruling 07:30
export const PENDING_PAGE = 20;

// The owner-editable allowlist (ops.settings `ai.allowedModels`, a JSON string array of prefixes); the default when the
// setting is missing or not a usable list. Read only by the write tools (one small primary-key read).
export async function allowedModels(): Promise<readonly string[]> {
  try {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, AI_ALLOWED_MODELS_SETTING)).limit(1);
    const v = row?.value;
    if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().toLowerCase()).slice(0, 50);
      if (list.length) return list;
    }
  } catch {
    console.warn("reading ai.allowedModels failed; using the default list");
  }
  return MCP_ALLOWED_MODELS;
}

const hourStart =(now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
type Row = Record<string, unknown>;

export type NewNote = { title: string; body: string; severity: NoteSeverity; appId: string | null; model: string; client: string };
export type InsertResult = { ok: true; id: string } | { ok: false; reason: "rate_limited"; retryAfter: number };

// One statement: count this hour's note for the key; insert only while the count is ≤ 20; when a row went in, delete
// what is beyond the newest 200 (the CTE sees the table before the insert, so the 199 newest old rows stay).
// keyId null = Watchbell's own advisor (owner 14 Oct): no key row, the hourly budget is counted per source instead.
export async function insertNote(note: NewNote, keyId: string | null, source: string, now: Date = new Date()): Promise<InsertResult> {
  const at = now.toISOString();
  const budget = keyId ? `ai-note:${keyId}` : `ai-note:${source}`;
  const res = await db().execute(sql`
    with hit as (
      insert into ops.rate_limits (key, window_start, count) values (${budget}, ${hourStart(now)}::timestamptz, 1)
      on conflict (key, window_start) do update set count = ops.rate_limits.count + 1
      returning count
    ), ins as (
      insert into ops.ai_notes (key_id, source, app_id, severity, title, body, model, client, created_at)
      select ${keyId}::uuid, ${source}, ${note.appId}, ${note.severity}, ${note.title}, ${note.body}, ${note.model}, ${note.client}, ${at}::timestamptz
      from hit where hit.count <= ${NOTES_PER_HOUR}
      returning id
    ), prune as (
      delete from ops.ai_notes where exists (select 1 from ins)
        and id in (select id from ops.ai_notes order by created_at desc, id desc offset ${NOTES_KEEP - 1})
      returning 1
    )
    select (select count from hit) as hits, (select id from ins) as id, (select count(*) from prune) as pruned`);
  const row = rowsOf<Row>(res)[0] ?? {};
  if (typeof row.id === "string" && row.id) return { ok: true, id: row.id };
  const retryAfter = Math.ceil((Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000 - now.getTime()) / 1000);
  return { ok: false, reason: "rate_limited", retryAfter };
}

// `model`: the Antigravity model the asker picked (null = the VM's own setting); `purpose` 'ping' = a model test from
// the Models page (answer "pong" with that model, or the reason it failed).
export type PendingQuestion = {
  id: string; contextKind: QuestionContextKind; contextId: string | null; question: string; createdAt: string; model: string | null; purpose: "ask" | "ping";
};

// The AI inbox: pending questions of the last 7 days, oldest first, at most 20. Asks and pings only: Kantor Virtual's
// questions for the Manager (purpose 'office', 0023) belong to the owner's local Claude Code hook, never Antigravity.
export async function pendingQuestions(now: Date = new Date()): Promise<PendingQuestion[]> {
  const since = new Date(now.getTime() - QUESTIONS_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await db().execute(sql`
    select id::text as id, context_kind, context_id::text as context_id, question, created_at::text as created_at, requested_model, purpose
    from ops.ai_questions where status = 'pending' and purpose in ('ask', 'ping') and created_at >= ${since}::timestamptz
    order by created_at asc, id asc limit ${PENDING_PAGE}`);
  return rowsOf<Row>(res).map((r) => ({
    id: String(r.id), contextKind: r.context_kind as QuestionContextKind, contextId: (r.context_id as string | null) ?? null,
    question: String(r.question ?? ""), createdAt: new Date(String(r.created_at)).toISOString(),
    model: typeof r.requested_model === "string" && r.requested_model ? r.requested_model : null, purpose: r.purpose === "ping" ? "ping" : "ask",
  }));
}

export type AnswerResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "answered" | "expired" | "rate_limited"; retryAfter?: number };

// One statement: count the key's answer budget; set the answer only on a pending question younger than 7 days
// (compare-and-set on status, so two agents can't both answer); report what the row was when nothing changed. An
// office question (purpose 'office') is not Antigravity's to answer: it reads as not found.
export async function answerQuestion(
  id: string, answer: { text: string; client: string; model: string }, keyId: string, now: Date = new Date(),
): Promise<AnswerResult> {
  const at = now.toISOString();
  const since = new Date(now.getTime() - QUESTIONS_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await db().execute(sql`
    with hit as (
      insert into ops.rate_limits (key, window_start, count) values (${`ai-answer:${keyId}`}, ${hourStart(now)}::timestamptz, 1)
      on conflict (key, window_start) do update set count = ops.rate_limits.count + 1
      returning count
    ), upd as (
      update ops.ai_questions set status = 'answered', answer = ${answer.text}, answered_by_client = ${answer.client},
        answered_by_model = ${answer.model}, answered_at = ${at}::timestamptz
      where id = ${id}::uuid and status = 'pending' and purpose in ('ask', 'ping') and created_at >= ${since}::timestamptz
        and (select count from hit) <= ${ANSWERS_PER_HOUR}
      returning id
    )
    select (select count from hit) as hits, (select count(*) from upd)::int as updated,
      (select status from ops.ai_questions where id = ${id}::uuid and purpose in ('ask', 'ping')) as status,
      (select created_at < ${since}::timestamptz from ops.ai_questions where id = ${id}::uuid and purpose in ('ask', 'ping')) as old`);
  const row = rowsOf<Row>(res)[0] ?? {};
  if (Number(row.updated) === 1) return { ok: true };
  if (Number(row.hits) > ANSWERS_PER_HOUR) {
    return { ok: false, reason: "rate_limited", retryAfter: Math.ceil((Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000 - now.getTime()) / 1000) };
  }
  if (row.status === null || row.status === undefined) return { ok: false, reason: "not_found" };
  if (row.status === "answered") return { ok: false, reason: "answered" };
  return { ok: false, reason: "expired" }; // status expired, or pending but older than 7 days
}

// The ONE retention step for the AI inbox tables (daily, registry T7; stage 5c integration removed T6's duplicate):
// notes older than 30 days or beyond the newest 200 go; inbox questions older than 7 days go (pending ones past their
// week are dropped with them: nobody will answer them any more).
export async function pruneAiNotes(now: Date): Promise<void> {
  const notesBefore = new Date(now.getTime() - NOTES_RETENTION_DAYS * 86_400_000).toISOString();
  const questionsBefore = new Date(now.getTime() - QUESTIONS_RETENTION_DAYS * 86_400_000).toISOString();
  await db().execute(sql`
    with n as (
      delete from ops.ai_notes where created_at < ${notesBefore}::timestamptz
        or id in (select id from ops.ai_notes order by created_at desc, id desc offset ${NOTES_KEEP})
      returning 1
    ),
    q as (delete from ops.ai_questions where created_at < ${questionsBefore}::timestamptz returning 1)
    select (select count(*) from n) as notes, (select count(*) from q) as questions`);
}
