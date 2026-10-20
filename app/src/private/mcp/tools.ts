import "server-only";
import { z } from "zod";
import { AI_COPY, MCP_COPY } from "@/lib/copy/edition";
import { recordEvents } from "@/lib/data/events-write";
import { readAliasBook } from "@/lib/data/aliases-db";
import { hideEmails } from "@/lib/view/display-name";
import { scrubLog } from "@/lib/logs/scrub";
import type { Scope } from "@/private/auth/api-key";
import { effectiveDefault, extraMcpTools, readAgSettings } from "@/private/ai/extras";
import {
  MAX_RUN_MS, MAX_RUN_QUESTIONS, MAX_RUN_TOKENS, MAX_RUNS, RUN_PURPOSES, RUN_STATUSES, runRecord, runTimeProblem,
} from "@/private/ai/agent-usage";
import * as usageDb from "@/private/ai/agent-usage-db";
import { clientLabel } from "./agent";
import * as data from "./data";
import { agId, define, fail, ok, type Tool, type ToolResult } from "./define";
import * as store from "./notes-db";
import { allowedModel, scrubDeep } from "./scrub";

// The MCP tools (R8: read-only, except the write:notes tools). Each tool: a JSON Schema for tools/list (derived
// from its Zod schema, so they can't drift), the scope a key needs, and a handler. Read tools return
// `{ content: [{ type: "text", text: JSON }], structuredContent: data }`, every string of `data` passed through
// scrubDeep (R5). Bad arguments or business rules → a tool execution error (`isError: true`) the model can fix;
// a missing scope or an unknown tool → a JSON-RPC error (server.ts).
export { fail, ok, type Tool, type ToolCtx, type ToolResult } from "./define";

const none = z.strictObject({});
const appArg = z.string().trim().min(1).max(100).describe("The app's id or its name as list_apps shows it.");

async function scrubbed(structured: Record<string, unknown>): Promise<ToolResult> {
  const book = await readAliasBook();
  return ok(scrubDeep(structured, book) as Record<string, unknown>);
}

async function ownerDefaultModel(now: Date): Promise<string | null> {
  try {
    const { report, prefs, allowed } = await readAgSettings(now);
    return effectiveDefault(report, prefs, allowed);
  } catch {
    console.warn(AI_COPY.defaultModelReadFailed);
    return null;
  }
}

const MODEL_HELP = "The model you are running as, e.g. gemini-3.8-flash or claude-sonnet-4-6. Must be on the console's allowlist.";
const NOTE_BODY_BYTES = 4096;
const tokens = (what: string) => z.number().int().min(0).max(MAX_RUN_TOKENS).describe(`${what} (usage.${what.replace(/ /g, "_")} of ${MCP_COPY.usageSource}), 0 when none.`);
const runModel = agId.describe("The model id the run used, as report_models lists it (e.g. gemini-3.8-flash-high).");
const purposeArg = z.enum(RUN_PURPOSES).describe("ask = answering an inbox question, ping = a model test, advisor = the twice-daily advisor run.");
// Run times: ISO 8601, not in the future (a minute of clock skew is fine), at most 24 h old.
const runTime = (help: string) => z.iso.datetime({ offset: true }).describe(help);
const ANSWER_MAX = 8000;

export const TOOLS: Tool[] = [
  define({
    name: "list_apps", title: "List apps", scope: "read:status", readOnly: true,
    description: "Every app Watchbell watches: state (ok, warn, err, …), 30-day uptime, linked database alias, latest production deploy and how many problems it has.",
    args: none,
    run: async (_a, { now }) => {
      const book = await readAliasBook();
      return ok(scrubDeep({ apps: await data.listAppsData(book, now) }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "get_app", title: "Get one app", scope: "read:status", readOnly: true,
    description: "One app in detail: state, monitors (paths only), problems with suggested fixes, its database (alias), latest deploy and advisor recommendations.",
    args: z.strictObject({ app: appArg }),
    run: async ({ app }, { now }) => {
      const ref = data.resolveApp(await data.appRefs(), app);
      if (!ref) return fail("Unknown app. Call list_apps for the app names and ids.");
      const book = await readAliasBook();
      const detail = await data.appData(book, now, ref.id);
      if (!detail) return fail("Unknown app. Call list_apps for the app names and ids.");
      return ok(scrubDeep({ app: detail }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "list_alerts", title: "List alerts", scope: "read:status", readOnly: true,
    description: "Alerts: state \"open\" (default) = firing now, critical first; \"recent\" = resolved in the last 7 days.",
    args: z.strictObject({ state: z.enum(["open", "recent"]).optional().describe("open (default) or recent") }),
    run: async ({ state }, { now }) => {
      const book = await readAliasBook();
      return ok(scrubDeep({ state: state ?? "open", alerts: await data.listAlertsData(book, now, state ?? "open") }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "list_monitors", title: "List monitors", scope: "read:status", readOnly: true,
    description: "Every uptime monitor (HTTP checks by path, heartbeats by name) with its state, last status code, latency, last error and 30-day uptime.",
    args: none,
    run: async (_a, { now }) => scrubbed({ monitors: await data.listMonitorsData(now) }),
  }),
  define({
    name: "recent_events", title: "Recent events", scope: "read:status", readOnly: true,
    description: "The newest console events (deployments, monitor changes, database changes, owner actions), newest first.",
    args: z.strictObject({ limit: z.number().int().min(1).max(100).optional().describe("1–100, default 20") }),
    run: async ({ limit }) => {
      const book = await readAliasBook();
      return ok(scrubDeep({ events: await data.recentEventsData(book, limit ?? 20) }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "recent_logs", title: "Recent logs", scope: "read:status", readOnly: true,
    description: "Stored runtime log lines (warnings and errors) of the last 24 hours, scrubbed of secrets, oldest first; optionally one app's.",
    args: z.strictObject({ app: appArg.optional(), limit: z.number().int().min(1).max(100).optional().describe("1–100, default 50") }),
    run: async ({ app, limit }, { now }) => {
      let appId: string | null = null;
      if (app) {
        const ref = data.resolveApp(await data.appRefs(), app);
        if (!ref) return fail("Unknown app. Call list_apps for the app names and ids.");
        appId = ref.id;
      }
      const book = await readAliasBook();
      return ok(scrubDeep({ logs: await data.recentLogsData(book, now, appId, limit ?? 50) }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "list_databases", title: "List databases", scope: "read:status", readOnly: true,
    description: "Watched databases by alias (db-a, db-b, …; real names are never shared), with kind, state and the apps that use them.",
    args: none,
    run: async () => {
      const book = await readAliasBook();
      return ok(scrubDeep({ databases: await data.listDatabasesData(book) }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "get_advisor", title: "Advisor recommendations", scope: "read:status", readOnly: true,
    description: "The console advisor's current recommendations (what to fix and why), optionally for one app.",
    args: z.strictObject({ app: appArg.optional() }),
    run: async ({ app }, { now }) => {
      const refs = await data.appRefs();
      let appId: string | null = null;
      if (app) {
        const ref = data.resolveApp(refs, app);
        if (!ref) return fail("Unknown app. Call list_apps for the app names and ids.");
        appId = ref.id;
      }
      const book = await readAliasBook();
      return ok(scrubDeep({ recommendations: await data.advisorData(book, now, appId, refs) }, book) as Record<string, unknown>);
    },
  }),
  define({
    name: "list_pending_questions", title: "AI inbox: pending questions", scope: "read:status", readOnly: true,
    description: `Questions the owner asked in Watchbell ("Ask AI") that wait for an answer, oldest first (at most 20), each with the console context it is about. Each item has \`model\` (${MCP_COPY.pendingModel}: the one the asker picked, else the owner's default; null = your own setting) and \`purpose\`: "ask" = a real question; "ping" = a model test from the Models page, answer exactly "pong" after running that model, or a short reason it failed (e.g. "error: quota exhausted"). Answer each with answer_question.`,
    args: none,
    run: async (_a, { now }) => {
      const qs = await store.pendingQuestions(now);
      const book = await readAliasBook();
      const ctxs = qs.length ? await data.questionContexts(book, now, qs.map((q) => ({ kind: q.contextKind, id: q.contextId }))) : new Map<string, unknown>();
      // A question without a picked model goes to the owner's default Antigravity model (Models page), else null.
      const fallback = qs.some((q) => !q.model) ? await ownerDefaultModel(now) : null;
      const questions = qs.map((q) => ({
        id: q.id, about: q.contextKind, question: q.question, askedAt: q.createdAt, model: q.model ?? fallback, purpose: q.purpose,
        context: q.contextId ? ctxs.get(`${q.contextKind}:${q.contextId}`) ?? null : null,
      }));
      return ok(scrubDeep({ questions }, book) as Record<string, unknown>);
    },
  }),
  // The private edition's extra tools (Antigravity's report_models, the router's report_router_quota); none in the
  // open source edition.
  ...extraMcpTools,
  define({
    name: "report_usage", title: "Report your runs' token usage", scope: "write:notes", readOnly: false,
    description: MCP_COPY.reportUsage,
    args: z.strictObject({
      runs: z.array(z.strictObject({
        model: runModel,
        purpose: purposeArg,
        status: z.enum(RUN_STATUSES).describe("ok, error (the run failed) or limit (a quota or rate limit stopped it)."),
        inputTokens: tokens("input tokens"),
        cachedTokens: tokens("cache read tokens"),
        outputTokens: tokens("output tokens"),
        thinkingTokens: tokens("thinking tokens"),
        durationMs: z.number().int().min(0).max(MAX_RUN_MS).describe("How long the run took in milliseconds (≤ 1 hour)."),
        at: runTime("When the run ended (ISO 8601). Default: now.").optional(),
        questions: z.number().int().min(0).max(MAX_RUN_QUESTIONS).optional().describe("How many inbox questions the run answered (0–20)."),
      })).min(1).max(MAX_RUNS),
    }),
    run: async ({ runs }, { key, now }) => {
      for (const [i, r] of runs.entries()) {
        const problem = runTimeProblem(r.at, now);
        if (problem) return fail(`Invalid arguments: runs.${i}.at: ${problem}`);
      }
      const res = await usageDb.recordRuns(runs.map((r) => runRecord(r, key, now)), key.keyId, now);
      if (!res.ok) return fail(`Usage report limit reached (${usageDb.USAGE_REPORTS_PER_HOUR} per hour for this key). Try again in ${Math.ceil(res.retryAfter / 60)} minutes.`);
      return ok({ recorded: res.recorded });
    },
  }),
  define({
    name: "report_activity", title: "Report what is running now", scope: "write:notes", readOnly: false,
    description: MCP_COPY.reportActivity,
    args: z.strictObject({
      running: z.strictObject({
        model: runModel,
        purpose: purposeArg,
        startedAt: runTime("When the run started (ISO 8601), not in the future."),
        questions: z.number().int().min(0).max(MAX_RUN_QUESTIONS).optional().describe("How many inbox questions this run answers (0–20)."),
      }).nullable().describe("The run in progress, or null when nothing runs."),
    }),
    run: async ({ running }, { key, now }) => {
      if (running && Date.parse(running.startedAt) > now.getTime() + 60_000) return fail("Invalid arguments: running.startedAt: startedAt is in the future");
      const value = { running: running ? { ...running, startedAt: new Date(running.startedAt).toISOString() } : null, updatedAt: now.toISOString() };
      const res = await usageDb.saveActivity(value, key.keyId, now);
      if (!res.ok) return fail(`Activity report limit reached (${usageDb.ACTIVITY_REPORTS_PER_HOUR} per hour for this key). Try again in ${Math.ceil(res.retryAfter / 60)} minutes.`);
      return ok({ ok: true });
    },
  }),
  define({
    name: "submit_ai_note", title: "Submit an AI note", scope: "write:notes", readOnly: false,
    description: "Post a short note (markdown) to the console's Recommendations card, optionally about one app. Write only when something needs the owner's attention. At most 20 notes per key per hour.",
    args: z.strictObject({
      title: z.string().trim().min(1).max(120).describe("≤ 120 characters"),
      body: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= NOTE_BODY_BYTES, { message: "body must be at most 4 KB" }).describe("Markdown, ≤ 4 KB. Links are shown as text."),
      severity: z.enum(["info", "warn", "crit"]),
      app: appArg.optional(),
      model: z.string().min(1).max(120).describe(MODEL_HELP),
    }),
    run: async ({ title, body, severity, app, model }, { key, now }) => {
      const m = allowedModel(model, await store.allowedModels());
      if (!m) return fail("This model is not allowed to write to Watchbell. Report the model you run as (for example gemini-3.8-flash).");
      let appId: string | null = null;
      if (app) {
        const ref = data.resolveApp(await data.appRefs(), app);
        if (!ref) return fail("Unknown app. Call list_apps for the app names and ids.");
        appId = ref.id;
      }
      const res = await store.insertNote({ title, body, severity, appId, model: m, client: clientLabel(key.client) }, key.keyId, key.client.name, now);
      if (!res.ok) return fail(`Note limit reached (${store.NOTES_PER_HOUR} per hour for this key). Try again in ${Math.ceil(res.retryAfter / 60)} minutes.`);
      try {
        await recordEvents([{
          type: "action", kind: severity === "crit" ? "err" : severity === "warn" ? "warn" : "info",
          message: `AI note from ${key.client.name}: ${hideEmails(scrubLog(title)).slice(0, 120)}`, detail: null,
          resourceId: appId, actorUserId: null, reason: "AiNoteSubmitted",
        }]);
      } catch {
        console.warn("AiNoteSubmitted event failed");
      }
      return ok({ id: res.id, status: "submitted" });
    },
  }),
  define({
    name: "answer_question", title: "AI inbox: answer a question", scope: "write:notes", readOnly: false,
    description: "Answer one pending question from list_pending_questions (markdown, ≤ 8000 characters). A question can be answered once.",
    args: z.strictObject({
      id: z.uuid().describe("The question id from list_pending_questions."),
      answer: z.string().trim().min(1).max(ANSWER_MAX).describe("Markdown, ≤ 8000 characters."),
      model: z.string().min(1).max(120).describe(MODEL_HELP),
    }),
    run: async ({ id, answer, model }, { key, now }) => {
      const m = allowedModel(model, await store.allowedModels());
      if (!m) return fail("This model is not allowed to write to Watchbell. Report the model you run as (for example gemini-3.8-flash).");
      const res = await store.answerQuestion(id, { text: answer, client: clientLabel(key.client), model: m }, key.keyId, now);
      if (res.ok) return ok({ id, status: "answered" });
      if (res.reason === "answered") return fail("This question was already answered.");
      if (res.reason === "expired") return fail("This question has expired.");
      if (res.reason === "rate_limited") return fail(`Answer limit reached (${store.ANSWERS_PER_HOUR} per hour for this key). Try again later.`);
      return fail("Unknown question. Call list_pending_questions for the open ones.");
    },
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export const findTool = (name: unknown): Tool | undefined => (typeof name === "string" ? byName.get(name) : undefined);

// tools/list shows a key only the tools its scopes allow (the write tools need write:notes).
export function toolsFor(scopes: Scope[]) {
  return TOOLS.filter((t) => scopes.includes(t.scope)).map((t) => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
  }));
}
