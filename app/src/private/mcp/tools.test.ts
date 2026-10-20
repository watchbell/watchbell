import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";

const h = vi.hoisted(() => ({
  insertNote: vi.fn(), answerQuestion: vi.fn(), pendingQuestions: vi.fn(), allowedModels: vi.fn(), recordEvents: vi.fn(),
  appRefs: vi.fn(), appData: vi.fn(), listAppsData: vi.fn(), questionContexts: vi.fn(), recentEventsData: vi.fn(), recentLogsData: vi.fn(),
  listAlertsData: vi.fn(), listMonitorsData: vi.fn(), listDatabasesData: vi.fn(), advisorData: vi.fn(),
  readAgSettings: vi.fn(), recordRuns: vi.fn(), saveActivity: vi.fn(),
}));
vi.mock("@/private/ai/agent-usage-db", () => ({ recordRuns: h.recordRuns, saveActivity: h.saveActivity, USAGE_REPORTS_PER_HOUR: 120, ACTIVITY_REPORTS_PER_HOUR: 240 }));
// The AI extras' settings read (either edition's ai/extras); the private edition's extra tools are tested next to them.
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: h.readAgSettings }));
vi.mock("@/lib/data/aliases-db", () => ({
  readAliasBook: async () => buildAliasBook([{ id: "d1", kind: "supabase_project", name: "ticketer-prod-db", firstSeenAt: "2026-01-01T00:00:00Z" }]),
}));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));
vi.mock("./notes-db", async () => ({
  insertNote: h.insertNote, answerQuestion: h.answerQuestion, pendingQuestions: h.pendingQuestions, allowedModels: h.allowedModels,
  NOTES_PER_HOUR: 20, ANSWERS_PER_HOUR: 60,
}));
vi.mock("./data", async () => {
  const real = await vi.importActual<typeof import("./data")>("./data");
  return {
    resolveApp: real.resolveApp, appRefs: h.appRefs, appData: h.appData, listAppsData: h.listAppsData, questionContexts: h.questionContexts,
    recentEventsData: h.recentEventsData, recentLogsData: h.recentLogsData, listAlertsData: h.listAlertsData, listMonitorsData: h.listMonitorsData,
    listDatabasesData: h.listDatabasesData, advisorData: h.advisorData,
  };
});

import { extraMcpTools } from "@/private/ai/extras";
import { MCP_ALLOWED_MODELS } from "./scrub";
import { findTool, TOOLS, toolsFor, type ToolCtx } from "./tools";

const APP_ID = "0b6f7c1e-1111-4222-8333-944445555666";
const Q_ID = "1b6f7c1e-1111-4222-8333-944445555666";
const key = {
  keyId: "k1", name: "laptop", prefix: "wp_Lm9x", scopes: ["read:status", "write:notes"] as ("read:status" | "write:notes")[], ratePerMin: 20, providerId: null, model: null,
  client: { name: "antigravity", version: "1.2", via: "mcp" as const, userAgent: "ua" },
};
const ctx: ToolCtx = { key, now: new Date("2026-10-13T03:20:00Z") };
const call = (name: string, args: unknown) => findTool(name)!.call(args, ctx);
const text = (r: { content: { text: string }[] }) => r.content[0].text;

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.appRefs.mockResolvedValue([{ id: APP_ID, name: "ticketer" }]);
  h.allowedModels.mockResolvedValue(MCP_ALLOWED_MODELS);
  h.insertNote.mockResolvedValue({ ok: true, id: "n1" });
  h.answerQuestion.mockResolvedValue({ ok: true });
  h.recordEvents.mockResolvedValue(undefined);
  for (const f of [h.listAppsData, h.recentEventsData, h.recentLogsData, h.listAlertsData, h.listMonitorsData, h.listDatabasesData, h.advisorData]) f.mockResolvedValue([]);
  h.appData.mockResolvedValue({ id: APP_ID, name: "ticketer", state: "err" });
  h.recordRuns.mockImplementation(async (recs: unknown[]) => ({ ok: true, recorded: recs.length }));
  h.saveActivity.mockResolvedValue({ ok: true });
  h.readAgSettings.mockResolvedValue({ report: null, prefs: { disabled: [], defaultModel: null }, allowed: MCP_ALLOWED_MODELS });
});

describe("tool registry", () => {
  it("has the 8 read tools, the inbox tools and the write tools, the edition's extra tools after the inbox", () => {
    const extra = extraMcpTools.map((t) => t.name);
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_apps", "get_app", "list_alerts", "list_monitors", "recent_events", "recent_logs", "list_databases", "get_advisor",
      "list_pending_questions", ...extra, "report_usage", "report_activity", "submit_ai_note", "answer_question",
    ]);
    expect(TOOLS).toHaveLength(13 + extra.length);
    const writes = [...extra, "report_usage", "report_activity", "submit_ai_note", "answer_question"];
    expect(TOOLS.filter((t) => t.scope === "write:notes").map((t) => t.name)).toEqual(writes);
    expect(TOOLS.filter((t) => !t.readOnly).map((t) => t.name)).toEqual(writes);
  });

  it("input schemas are closed JSON Schema objects without $schema", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema, t.name).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.inputSchema.$schema).toBeUndefined();
    }
    expect(findTool("submit_ai_note")!.inputSchema.required).toEqual(["title", "body", "severity", "model"]);
  });

  it("every tool rejects unknown arguments as a tool error", async () => {
    for (const t of TOOLS) {
      const r = await t.call({ bogus: 1 }, ctx);
      expect(r.isError, t.name).toBe(true);
      expect(text(r)).toContain("Unknown argument: bogus");
    }
    expect(h.insertNote).not.toHaveBeenCalled();
    expect(h.answerQuestion).not.toHaveBeenCalled();
  });

  it("toolsFor hides the write tools from keys without write:notes", () => {
    expect(toolsFor(["read:status"]).map((t) => t.name)).not.toContain("submit_ai_note");
    expect(toolsFor(["read:status"]).map((t) => t.name)).not.toContain("answer_question");
    expect(toolsFor(["read:status"]).map((t) => t.name)).not.toContain("report_models");
    expect(toolsFor(["read:status"]).map((t) => t.name)).not.toContain("report_router_quota");
    expect(toolsFor(["read:status"]).map((t) => t.name)).toContain("list_pending_questions");
    expect(toolsFor(["read:status", "write:notes"]).find((t) => t.name === "answer_question")?.annotations).toMatchObject({ readOnlyHint: false });
  });
});

describe("read tools", () => {
  it("get_app resolves a name or an id and returns text + structuredContent", async () => {
    const r = await call("get_app", { app: "Ticketer" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ app: { id: APP_ID, name: "ticketer", state: "err" } });
    expect(JSON.parse(text(r))).toEqual(r.structuredContent);
    expect(h.appData).toHaveBeenCalledWith(expect.anything(), ctx.now, APP_ID);
    await call("get_app", { app: APP_ID });
    expect(h.appData).toHaveBeenCalledTimes(2);
  });

  it("get_app with an unknown app is a tool error", async () => {
    const r = await call("get_app", { app: "nope" });
    expect(r).toMatchObject({ isError: true });
    expect(h.appData).not.toHaveBeenCalled();
  });

  it("limits are bounded: recent_events 1–100, default 20", async () => {
    expect((await call("recent_events", { limit: 101 })).isError).toBe(true);
    expect((await call("recent_events", { limit: 0 })).isError).toBe(true);
    await call("recent_events", {});
    expect(h.recentEventsData).toHaveBeenCalledWith(expect.anything(), 20);
    await call("recent_logs", { app: "ticketer", limit: 5 });
    expect(h.recentLogsData).toHaveBeenCalledWith(expect.anything(), ctx.now, APP_ID, 5);
  });

  it("list_alerts takes open (default) or recent only", async () => {
    await call("list_alerts", undefined);
    expect(h.listAlertsData).toHaveBeenCalledWith(expect.anything(), ctx.now, "open");
    expect((await call("list_alerts", { state: "all" })).isError).toBe(true);
  });

  it("outputs are scrubbed as a last pass", async () => {
    h.listMonitorsData.mockResolvedValue([{ app: "ticketer", path: "/health", lastError: "connect to postgres://u:p@h/ticketer-prod-db by a@b.co" }]);
    const r = await call("list_monitors", {});
    for (const s of ["@", "://", "postgres", "ticketer-prod-db"]) expect(text(r)).not.toContain(s);
  });
});

describe("AI inbox", () => {
  it("list_pending_questions returns pending questions with their scrubbed context", async () => {
    h.pendingQuestions.mockResolvedValue([
      { id: Q_ID, contextKind: "app", contextId: APP_ID, question: "Why is ticketer down? (owner a@b.co)", createdAt: "2026-10-13T02:00:00.000Z", model: null, purpose: "ask" },
      { id: "q2", contextKind: "general", contextId: null, question: "Anything to fix?", createdAt: "2026-10-13T02:30:00.000Z", model: "claude-opus-4-6-thinking", purpose: "ask" },
      { id: "q3", contextKind: "general", contextId: null, question: "ping", createdAt: "2026-10-13T02:31:00.000Z", model: "gemini-3.8-flash-high", purpose: "ping" },
    ]);
    h.questionContexts.mockResolvedValue(new Map([[`app:${APP_ID}`, { name: "ticketer", problems: [{ where: "Database ticketer-prod-db" }] }]]));
    const r = await call("list_pending_questions", {});
    expect(r.structuredContent).toEqual({
      questions: [
        { id: Q_ID, about: "app", question: "Why is ticketer down? (owner [email hidden])", askedAt: "2026-10-13T02:00:00.000Z", model: null, purpose: "ask", context: { name: "ticketer", problems: [{ where: "Database db-a" }] } },
        { id: "q2", about: "general", question: "Anything to fix?", askedAt: "2026-10-13T02:30:00.000Z", model: "claude-opus-4-6-thinking", purpose: "ask", context: null },
        { id: "q3", about: "general", question: "ping", askedAt: "2026-10-13T02:31:00.000Z", model: "gemini-3.8-flash-high", purpose: "ping", context: null },
      ],
    });
    expect(h.questionContexts).toHaveBeenCalledTimes(1);
  });

  it("list_pending_questions with an empty inbox reads no context", async () => {
    h.pendingQuestions.mockResolvedValue([]);
    expect((await call("list_pending_questions", {})).structuredContent).toEqual({ questions: [] });
    expect(h.questionContexts).not.toHaveBeenCalled();
  });

  it("answer_question stores the answer with the detected client and the normalised model", async () => {
    const r = await call("answer_question", { id: Q_ID, answer: "Roll back.", model: "Claude Opus 4.6 (Thinking)", source: "evil" });
    expect(r.structuredContent).toEqual({ id: Q_ID, status: "answered" });
    expect(h.answerQuestion).toHaveBeenCalledWith(Q_ID, { text: "Roll back.", client: "antigravity/1.2", model: "claude-opus-4.6-thinking" }, "k1", ctx.now);
  });

  it("answer_question requires an allowed model", async () => {
    for (const model of [undefined, "gpt-4o", "openai/gpt-5"]) {
      const r = await call("answer_question", { id: Q_ID, answer: "x", ...(model ? { model } : {}) });
      expect(r.isError, String(model)).toBe(true);
    }
    expect(h.answerQuestion).not.toHaveBeenCalled();
  });

  it("answer_question rejects answers over 8000 characters and bad ids", async () => {
    expect((await call("answer_question", { id: Q_ID, answer: "x".repeat(8001), model: "gemini-3.8-flash" })).isError).toBe(true);
    expect((await call("answer_question", { id: "q1", answer: "x", model: "gemini-3.8-flash" })).isError).toBe(true);
    expect(h.answerQuestion).not.toHaveBeenCalled();
  });

  it("answer_question explains already answered / expired / unknown / rate limited", async () => {
    for (const [reason, want] of [["answered", "already answered"], ["expired", "expired"], ["not_found", "Unknown question"], ["rate_limited", "limit"]] as const) {
      h.answerQuestion.mockResolvedValueOnce({ ok: false, reason });
      const r = await call("answer_question", { id: Q_ID, answer: "x", model: "gemini-3.8-flash" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(want);
    }
  });

  it("answer_question honours the owner's allowlist", async () => {
    h.allowedModels.mockResolvedValue(["gemini"]);
    expect((await call("answer_question", { id: Q_ID, answer: "x", model: "claude-sonnet-4-6" })).isError).toBe(true);
  });
});

describe("submit_ai_note (R8)", () => {
  const good = { title: "ticketer is down", body: "**/health** answers 503. Roll back.", severity: "crit", app: "ticketer", model: "gemini-3.8-flash" };

  it("inserts with source = the detected client, even when the args carry one", async () => {
    const r = await call("submit_ai_note", { ...good, source: "evil-bot" });
    expect(r.structuredContent).toEqual({ id: "n1", status: "submitted" });
    expect(h.insertNote).toHaveBeenCalledWith(
      { title: good.title, body: good.body, severity: "crit", appId: APP_ID, model: "gemini-3.8-flash", client: "antigravity/1.2" }, "k1", "antigravity", ctx.now,
    );
    expect(h.recordEvents).toHaveBeenCalledWith([expect.objectContaining({ reason: "AiNoteSubmitted", resourceId: APP_ID, kind: "err", message: "AI note from antigravity: ticketer is down" })]);
  });

  it("an app-less note is console-wide", async () => {
    const { app: _app, ...rest } = good;
    void _app;
    await call("submit_ai_note", rest);
    expect(h.insertNote.mock.calls[0][0]).toMatchObject({ appId: null });
  });

  it("rejects a title over 120 chars, a body over 4 KB, a bad severity, an unknown app", async () => {
    const bad = [
      { ...good, title: "x".repeat(121) },
      { ...good, body: "é".repeat(2049) }, // 4098 bytes
      { ...good, severity: "critical" },
      { ...good, app: "not-an-app" },
      { ...good, title: "" },
    ];
    for (const args of bad) expect((await call("submit_ai_note", args)).isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    expect(h.insertNote).not.toHaveBeenCalled();
    expect((await call("submit_ai_note", { ...good, body: "x".repeat(4096) })).isError).toBeUndefined();
  });

  it("requires an allowed model: Gemini, Antigravity, Gemma on Workers AI and Claude in Antigravity; nothing else", async () => {
    for (const model of ["gemini-3.8-flash", "antigravity-preview-latest", "@cf/google/gemma-3-12b-it", "claude-sonnet-4-6", "Claude Opus 4.6 (Thinking)"]) {
      expect((await call("submit_ai_note", { ...good, model })).isError, model).toBeUndefined();
    }
    h.insertNote.mockClear();
    for (const model of ["gpt-4o", "llama-3.3-70b", "deepseek-r1"]) expect((await call("submit_ai_note", { ...good, model })).isError, model).toBe(true);
    expect((await call("submit_ai_note", { title: good.title, body: good.body, severity: "info" })).isError).toBe(true);
    expect(h.insertNote).not.toHaveBeenCalled();
  });

  it("the 21st note in an hour is rejected and records no event", async () => {
    h.insertNote.mockResolvedValue({ ok: false, reason: "rate_limited", retryAfter: 600 });
    const r = await call("submit_ai_note", good);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("20 per hour");
    expect(h.recordEvents).not.toHaveBeenCalled();
  });

  it("a failing audit event doesn't fail the note", async () => {
    h.recordEvents.mockRejectedValue(new Error("db"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await call("submit_ai_note", good)).structuredContent).toEqual({ id: "n1", status: "submitted" });
    warn.mockRestore();
  });
});

describe("report_usage (owner 13 Oct, Usage & Analytics)", () => {
  const run = { model: "gemini-3.8-flash", purpose: "ask", status: "ok", inputTokens: 2000, cachedTokens: 18000, outputTokens: 300, thinkingTokens: 120, durationMs: 4200 };

  it("records one 'agent' row per run for the calling key and client and returns the count", async () => {
    const r = await call("report_usage", { runs: [run, { ...run, model: "claude-sonnet-4-6", purpose: "ping", status: "limit", at: "2026-10-13T03:00:00Z", questions: 0 }] });
    expect(r.structuredContent).toEqual({ recorded: 2 });
    const [recs, keyId, now] = h.recordRuns.mock.calls[0];
    expect(keyId).toBe("k1");
    expect(now).toBe(ctx.now);
    expect(recs).toEqual([
      { at: ctx.now, keyId: "k1", client: key.client, providerId: null, model: "gemini-3.8-flash", kind: "agent", tool: "ask", tokensIn: 2000, tokensCached: 18000, tokensOut: 300, tokensThinking: 120, latencyMs: 4200, status: 200, errorClass: null, stream: false },
      expect.objectContaining({ at: new Date("2026-10-13T03:00:00Z"), model: "claude-sonnet-4-6", tool: "ping", status: 429, errorClass: "quota" }),
    ]);
  });

  it("validates every field strictly and writes nothing on a bad run", async () => {
    const bad = [
      {},
      { runs: [] },
      { runs: Array.from({ length: 21 }, () => run) },
      { runs: [{ ...run, model: "Gemini Flash" }] },
      { runs: [{ ...run, model: "x".repeat(81) }] },
      { runs: [{ ...run, purpose: "chat" }] },
      { runs: [{ ...run, status: "done" }] },
      { runs: [{ ...run, inputTokens: -1 }] },
      { runs: [{ ...run, cachedTokens: 1.5 }] },
      { runs: [{ ...run, outputTokens: 10_000_001 }] },
      { runs: [{ ...run, thinkingTokens: "5" }] },
      { runs: [{ ...run, durationMs: 3_600_001 }] },
      { runs: [{ ...run, at: "yesterday" }] },
      { runs: [{ ...run, at: "2026-10-13T03:30:00Z" }] }, // future (now 03:20Z)
      { runs: [{ ...run, at: "2026-10-12T03:00:00Z" }] }, // older than 24 h
      { runs: [{ ...run, questions: 21 }] },
      { runs: [{ ...run, extra: 1 }] },
      { runs: [{ ...run, thinkingTokens: undefined }] },
    ];
    for (const args of bad) expect((await call("report_usage", args)).isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    expect(h.recordRuns).not.toHaveBeenCalled();
    expect((await call("report_usage", { runs: Array.from({ length: 20 }, () => ({ ...run, inputTokens: 10_000_000, durationMs: 3_600_000, at: "2026-10-12T03:30:00Z" })) })).isError).toBeUndefined();
  });

  it("past the hourly budget it is a tool error", async () => {
    h.recordRuns.mockResolvedValue({ ok: false, reason: "rate_limited", retryAfter: 600 });
    const r = await call("report_usage", { runs: [run] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("120 per hour");
  });

  it("is a write tool with runs required", () => {
    expect(findTool("report_usage")).toMatchObject({ scope: "write:notes", readOnly: false });
    expect(findTool("report_usage")!.inputSchema.required).toEqual(["runs"]);
    expect(toolsFor(["read:status"]).map((t) => t.name)).not.toContain("report_usage");
  });
});

describe("report_activity (owner 13 Oct, Usage & Analytics)", () => {
  it("stores the run in progress with the time Watchpost got it", async () => {
    const running = { model: "claude-sonnet-4-6", purpose: "advisor", startedAt: "2026-10-13T10:19:30+07:00", questions: 3 };
    const r = await call("report_activity", { running });
    expect(r.structuredContent).toEqual({ ok: true });
    expect(h.saveActivity).toHaveBeenCalledWith({ running: { ...running, startedAt: "2026-10-13T03:19:30.000Z" }, updatedAt: ctx.now.toISOString() }, "k1", ctx.now);
  });

  it("null means idle", async () => {
    await call("report_activity", { running: null });
    expect(h.saveActivity).toHaveBeenCalledWith({ running: null, updatedAt: ctx.now.toISOString() }, "k1", ctx.now);
  });

  it("validates strictly", async () => {
    const ok = { model: "gemini-3.8-flash", purpose: "ask", startedAt: "2026-10-13T03:19:00Z" };
    const bad = [
      {},
      { running: { ...ok, model: "Gemini" } },
      { running: { ...ok, purpose: "chat" } },
      { running: { ...ok, startedAt: "soon" } },
      { running: { ...ok, startedAt: "2026-10-13T03:30:00Z" } },
      { running: { ...ok, questions: -1 } },
      { running: { ...ok, extra: true } },
      { running: "busy" },
    ];
    for (const args of bad) expect((await call("report_activity", args)).isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    expect(h.saveActivity).not.toHaveBeenCalled();
  });

  it("past the hourly budget it is a tool error", async () => {
    h.saveActivity.mockResolvedValue({ ok: false, reason: "rate_limited", retryAfter: 60 });
    const r = await call("report_activity", { running: null });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("240 per hour");
  });

  it("is a write tool with running required", () => {
    expect(findTool("report_activity")).toMatchObject({ scope: "write:notes", readOnly: false });
    expect(findTool("report_activity")!.inputSchema.required).toEqual(["running"]);
  });
});
