import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";

const APP_ID = "0b6f7c1e-1111-4222-8333-944445555666";
const h = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(), recordMcpCall: vi.fn(), afters: [] as (() => Promise<void> | void)[],
  insertNote: vi.fn(), appData: vi.fn(), pendingQuestions: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => { h.afters.push(fn); } }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.authenticateApiKey }));
vi.mock("./agent", async () => ({ ...(await vi.importActual<typeof import("./agent")>("./agent")), recordMcpCall: h.recordMcpCall }));
vi.mock("@/lib/data/aliases-db", () => ({ readAliasBook: async () => buildAliasBook([]) }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: vi.fn() }));
vi.mock("./notes-db", () => ({
  insertNote: h.insertNote, answerQuestion: vi.fn(), pendingQuestions: h.pendingQuestions, allowedModels: async () => ["gemini", "antigravity", "@cf/google/gemma", "claude"],
  NOTES_PER_HOUR: 20, ANSWERS_PER_HOUR: 60,
}));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: vi.fn() }));
vi.mock("@/private/ai/agent-usage-db", () => ({ recordRuns: vi.fn(), saveActivity: vi.fn(), USAGE_REPORTS_PER_HOUR: 120, ACTIVITY_REPORTS_PER_HOUR: 240 }));
vi.mock("./data", async () => ({
  resolveApp: (await vi.importActual<typeof import("./data")>("./data")).resolveApp,
  appRefs: async () => [{ id: APP_ID, name: "ticketer" }], appData: h.appData, questionContexts: async () => new Map(),
}));

import { extraMcpTools } from "@/private/ai/extras";
import { forgetClients } from "./agent";
import { handleMcp, INSTRUCTIONS, SERVER_INFO } from "./server";

const KEY = `wp_${"a".repeat(40)}`;
const headerClient = { name: "node", version: "22", via: "user-agent" as const, userAgent: "node/22" };
const ctx = (scopes: string[] = ["read:status"]) => ({ keyId: "k1", name: "laptop", prefix: "wp_aaaa", scopes, ratePerMin: 20, providerId: null, model: null, client: headerClient });
let seq = 0;
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://ops.example.com/api/v1/mcp", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  });
}
const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) });
async function send(body: unknown, headers?: Record<string, string>) {
  const res = await handleMcp(post(body, headers));
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}
const flush = async () => { for (const f of h.afters.splice(0)) await f(); };

beforeEach(() => {
  h.authenticateApiKey.mockReset().mockResolvedValue({ ok: true, key: ctx() });
  h.recordMcpCall.mockReset().mockResolvedValue(undefined);
  h.insertNote.mockReset().mockResolvedValue({ ok: true, id: "n1" });
  h.appData.mockReset().mockResolvedValue({ id: APP_ID, name: "ticketer", state: "err", problems: [] });
  h.pendingQuestions.mockReset().mockResolvedValue([]);
  h.afters.length = 0;
  forgetClients();
});

describe("HTTP layer", () => {
  it("no or bad key → the 401 from authentication, before any JSON-RPC", async () => {
    h.authenticateApiKey.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "invalid_api_key", message: "x" } }, { status: 401 }) });
    const { res, body } = await send("{not json");
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: { type: "invalid_api_key", message: "x" } });
    expect(h.authenticateApiKey).toHaveBeenCalledWith(expect.any(Request), "read:status");
  });

  it("a key without read:status → 403; over its rate → 429 (passed through)", async () => {
    h.authenticateApiKey.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "missing_scope", message: "x" } }, { status: 403 }) });
    expect((await send(rpc("tools/list"))).res.status).toBe(403);
    h.authenticateApiKey.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "key_rate_limit", message: "x" } }, { status: 429, headers: { "Retry-After": "12" } }) });
    const { res } = await send(rpc("tools/list"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });

  it("a foreign Origin → 403 (DNS rebinding), our own is fine", async () => {
    const { res, body } = await send(rpc("ping"), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(h.authenticateApiKey).not.toHaveBeenCalled();
    expect((await send(rpc("ping"), { origin: "https://ops.example.com" })).res.status).toBe(200);
  });

  it("malformed JSON → 400 -32700; a batch → 400 -32600", async () => {
    expect(await send("{nope")).toMatchObject({ res: { status: 400 }, body: { error: { code: -32700 }, id: null } });
    expect(await send([rpc("ping")])).toMatchObject({ res: { status: 400 }, body: { error: { code: -32600 } } });
  });

  it("a body over 64 KB → 413", async () => {
    expect((await send(rpc("ping", { pad: "x".repeat(70_000) }))).res.status).toBe(413);
  });

  it("answers are JSON, never cached, and mint no session id", async () => {
    const { res } = await send(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Antigravity", version: "1.2" } }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("legacy round trip: initialize → initialized → tools/list → tools/call", () => {
  it("works statelessly and records the agent from clientInfo", async () => {
    const init = await send(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Antigravity", version: "1.2" } }));
    expect(init.res.status).toBe(200);
    expect(init.body.result).toEqual({
      protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
    });
    expect(init.body.result.serverInfo.name).toBe("watchbell");

    const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-06-18" });
    expect(note.res.status).toBe(202);
    expect(note.body).toBeNull();

    const list = await send(rpc("tools/list"), { "mcp-protocol-version": "2025-06-18" });
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_app");
    expect(names).not.toContain("submit_ai_note");
    expect(list.body.result.resultType).toBeUndefined();

    const call = await send(rpc("tools/call", { name: "get_app", arguments: { app: "ticketer" } }), { "mcp-protocol-version": "2025-06-18" });
    expect(call.body.result.structuredContent).toEqual({ app: { id: APP_ID, name: "ticketer", state: "err", problems: [] } });
    expect(JSON.parse(call.body.result.content[0].text)).toEqual(call.body.result.structuredContent);

    await flush();
    const recs = h.recordMcpCall.mock.calls.map((c) => c[0]);
    expect(recs.map((r) => r.tool)).toEqual(["initialize", "tools/list", "get_app"]);
    for (const r of recs) expect(r).toMatchObject({ kind: "mcp", keyId: "k1", status: 200, client: { name: "antigravity", version: "1.2", via: "mcp" } });
  });

  it("an empty inbox check (list_pending_questions with no questions) is not recorded; one with questions is", async () => {
    // The VM poller asks every few seconds; empty answers would flood Logs and ai_usage (13 Oct).
    const empty = await send(rpc("tools/call", { name: "list_pending_questions", arguments: {} }));
    expect(empty.body.result.structuredContent).toEqual({ questions: [] });
    await flush();
    expect(h.recordMcpCall).not.toHaveBeenCalled();
    h.pendingQuestions.mockResolvedValue([{ id: "q1", contextKind: "general", contextId: null, question: "hi", createdAt: new Date("2026-10-13T08:00:00Z") }]);
    const full = await send(rpc("tools/call", { name: "list_pending_questions", arguments: {} }));
    expect(full.body.result.structuredContent.questions).toHaveLength(1);
    await flush();
    expect(h.recordMcpCall.mock.calls.map((c) => c[0].tool)).toEqual(["list_pending_questions"]);
  });

  it("ping answers {} and is not recorded", async () => {
    const { body } = await send(rpc("ping"));
    expect(body.result).toEqual({});
    await flush();
    expect(h.recordMcpCall).not.toHaveBeenCalled();
  });

  it("an unknown method → -32601 (HTTP 200 for legacy clients)", async () => {
    const { res, body } = await send(rpc("resources/list"));
    expect(res.status).toBe(200);
    expect(body.error.code).toBe(-32601);
  });

  it("an unknown tool → -32602", async () => {
    expect((await send(rpc("tools/call", { name: "drop_db", arguments: {} }))).body.error.code).toBe(-32602);
  });

  it("an unsupported MCP-Protocol-Version → 400 -32022", async () => {
    const { res, body } = await send(rpc("tools/list"), { "mcp-protocol-version": "2024-01-01" });
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: -32022, data: { supported: expect.arrayContaining(["2026-07-28", "2025-06-18"]) } });
  });

  it("a crashing tool → -32603 with no detail", async () => {
    h.appData.mockRejectedValue(new Error("password=hunter2 in driver error"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { body } = await send(rpc("tools/call", { name: "get_app", arguments: { app: "ticketer" } }));
    expect(body.error.code).toBe(-32603);
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(String(err.mock.calls[0])).not.toContain("hunter2");
    err.mockRestore();
  });

  it("without clientInfo the header-detected client is recorded", async () => {
    await send(rpc("tools/list"));
    await flush();
    expect(h.recordMcpCall.mock.calls[0][0].client).toEqual(headerClient);
  });
});

describe("write tools and scopes (R8)", () => {
  const args = { title: "ticketer is down", body: "Roll back.", severity: "crit", app: "ticketer", model: "gemini-3.8-flash" };

  it("submit_ai_note without write:notes → JSON-RPC error and no insert", async () => {
    const { body } = await send(rpc("tools/call", { name: "submit_ai_note", arguments: args }));
    expect(body.error).toMatchObject({ code: -32001, message: expect.stringContaining("write:notes") });
    expect(h.insertNote).not.toHaveBeenCalled();
  });

  it("with write:notes: tools/list shows it and the call inserts with the detected client as source", async () => {
    h.authenticateApiKey.mockResolvedValue({ ok: true, key: ctx(["read:status", "write:notes"]) });
    await send(rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Antigravity", version: "1.2" } }));
    const names = (await send(rpc("tools/list"))).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["submit_ai_note", "answer_question", "list_pending_questions", ...extraMcpTools.map((t) => t.name)]));
    expect(names).toEqual(expect.arrayContaining(["report_usage", "report_activity"]));
    expect(names).toHaveLength(13 + extraMcpTools.length);
    const { body } = await send(rpc("tools/call", { name: "submit_ai_note", arguments: { ...args, source: "someone-else" } }));
    expect(body.result.structuredContent).toEqual({ id: "n1", status: "submitted" });
    expect(h.insertNote).toHaveBeenCalledWith(expect.objectContaining({ client: "antigravity/1.2", model: "gemini-3.8-flash" }), "k1", "antigravity", expect.any(Date));
  });

  it("a rejected model is a tool error (isError), recorded as tool_error", async () => {
    h.authenticateApiKey.mockResolvedValue({ ok: true, key: ctx(["read:status", "write:notes"]) });
    const { body } = await send(rpc("tools/call", { name: "submit_ai_note", arguments: { ...args, model: "gpt-4o" } }));
    expect(body.result.isError).toBe(true);
    await flush();
    expect(h.recordMcpCall.mock.calls[0][0]).toMatchObject({ tool: "submit_ai_note", errorClass: "tool_error" });
  });
});

describe("modern (2026-07-28) requests", () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Gemini CLI", version: "0.9.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const hdr = (method: string, name?: string) => ({ "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

  it("server/discover lists the versions; results carry resultType", async () => {
    const { body } = await send(rpc("server/discover", { _meta: meta }), hdr("server/discover"));
    expect(body.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"], capabilities: { tools: { listChanged: false } } });
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("watchbell");
  });

  it("tools/call with per-request clientInfo records that client", async () => {
    const { body } = await send(rpc("tools/call", { name: "get_app", arguments: { app: "ticketer" }, _meta: meta }), hdr("tools/call", "get_app"));
    expect(body.result.resultType).toBe("complete");
    await flush();
    expect(h.recordMcpCall.mock.calls[0][0].client).toMatchObject({ name: "gemini-cli", version: "0.9.0", via: "mcp" });
  });

  it("header mismatch → 400 -32020; unknown method → 404 -32601", async () => {
    expect(await send(rpc("tools/call", { name: "get_app", arguments: { app: "x" }, _meta: meta }), hdr("tools/call", "list_apps"))).toMatchObject({ res: { status: 400 }, body: { error: { code: -32020 } } });
    expect(await send(rpc("resources/list", { _meta: meta }), hdr("resources/list"))).toMatchObject({ res: { status: 404 }, body: { error: { code: -32601 } } });
  });
});
