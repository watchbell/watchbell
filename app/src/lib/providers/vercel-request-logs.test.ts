import { describe, expect, it, vi } from "vitest";
import { messageHash, readRequestLogs } from "./vercel-request-logs";

const NOW = new Date("2026-10-13T12:00:00Z");
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const row = (o: Record<string, unknown> = {}) => ({
  requestId: "req1", timestamp: iso(5), deploymentId: "dpl_1", requestMethod: "GET", requestPath: "/courses", statusCode: 200, environment: "production",
  logs: [{ level: "error", message: "boom" }], events: [{ source: "serverless" }], ...o,
});
const range = { since: new Date(NOW.getTime() - 3_600_000), until: NOW, now: NOW };
const fetchOf = (...responses: (Response | Error)[]) => {
  const f = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) f.mockRejectedValueOnce(r);
    else f.mockResolvedValueOnce(r);
  }
  return f;
};
const urlOf = (f: ReturnType<typeof vi.fn>, i = 0) => new URL(f.mock.calls[i][0] as string);
const hang = () => vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))));

describe("readRequestLogs request", () => {
  it("asks vercel.com (not api.vercel.com) with the bearer token and the CLI's query parameters", async () => {
    const f = fetchOf(json({ rows: [] }));
    const r = await readRequestLogs(TOKEN, "team_a", "prj_1", { ...range, levels: ["warning", "error"], deploymentId: "dpl_9", environment: "production", fetch: f });
    expect(r).toEqual({ ok: true, lines: [], more: false });
    const u = urlOf(f);
    expect(`${u.origin}${u.pathname}`).toBe("https://vercel.com/api/logs/request-logs");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      projectId: "prj_1", ownerId: "team_a", page: "0", startDate: String(range.since.getTime()), endDate: String(NOW.getTime()),
      deploymentId: "dpl_9", environment: "production", level: "warning,error",
    });
    expect(f.mock.calls[0][1]).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" });
  });

  it("leaves out the optional filters it wasn't given, and sends fatal as error", async () => {
    const f = fetchOf(json({ rows: [] }), json({ rows: [] }));
    await readRequestLogs(TOKEN, "team_a", "prj_1", { ...range, fetch: f });
    expect([...urlOf(f).searchParams.keys()].sort()).toEqual(["endDate", "ownerId", "page", "projectId", "startDate"]);
    await readRequestLogs(TOKEN, "team_a", "prj_1", { ...range, levels: ["warning", "error", "fatal"], fetch: f });
    expect(urlOf(f, 1).searchParams.get("level")).toBe("warning,error");
  });

  it("clamps since to 24 hours back", async () => {
    const f = fetchOf(json({ rows: [] }));
    await readRequestLogs(TOKEN, "team_a", "prj_1", { since: new Date(NOW.getTime() - 5 * 86_400_000), until: NOW, now: NOW, fetch: f });
    expect(urlOf(f).searchParams.get("startDate")).toBe(String(NOW.getTime() - 86_400_000));
  });

  it("reads nothing when the window is empty after clamping", async () => {
    const f = fetchOf();
    const r = await readRequestLogs(TOKEN, "team_a", "prj_1", { since: NOW, until: new Date(NOW.getTime() - 1000), now: NOW, fetch: f });
    expect(r).toEqual({ ok: true, lines: [], more: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("readRequestLogs lines", () => {
  it("emits one line per wanted message with a stable row id, request fields and source", async () => {
    const f = fetchOf(json({ rows: [row({ logs: [
      { level: "info", message: "start" }, { level: "warning", message: "slow" }, { level: "error", message: "failed", messageTruncated: true },
    ] })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["warning", "error"], fetch: f });
    expect(r.ok && r.lines).toEqual([
      { rowId: `req1:${messageHash("warning", "slow")}`, at: new Date(iso(5)), level: "warning", message: "slow", requestMethod: "GET", requestPath: "/courses", statusCode: 200, source: "serverless", deploymentId: "dpl_1" },
      { rowId: `req1:${messageHash("error", "failed")}`, at: new Date(iso(5)), level: "error", message: "failed", requestMethod: "GET", requestPath: "/courses", statusCode: 200, source: "serverless", deploymentId: "dpl_1" },
    ]);
  });

  it("keeps every level when none is asked for", async () => {
    const f = fetchOf(json({ rows: [row({ logs: [{ level: "info", message: "a" }, { level: "debug", message: "b" }] })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(r.ok && r.lines.map((l) => [l.rowId, l.level])).toEqual([[`req1:${messageHash("info", "a")}`, "info"], [`req1:${messageHash("debug", "b")}`, "debug"]]);
  });

  it("turns a 5xx row without messages into one error line, and ignores a 2xx row without messages", async () => {
    const f = fetchOf(json({ rows: [
      row({ requestId: "r5", logs: [], statusCode: 504, requestMethod: "POST", requestPath: "/api/x" }),
      row({ requestId: "r6", logs: undefined, statusCode: 502 }),
      row({ requestId: "r2", logs: [], statusCode: 200 }),
    ] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["error"], fetch: f });
    expect(r.ok && r.lines.map((l) => [l.rowId, l.level, l.message, l.statusCode])).toEqual([
      ["r5:status", "error", "POST /api/x → 504", 504],
      ["r6:status", "error", "GET /courses → 502", 502],
    ]);
  });

  it("still makes the 5xx line when the row only logged info or warnings, but not when it has an error line", async () => {
    const f = fetchOf(json({ rows: [
      row({ requestId: "t", logs: [{ level: "info", message: "start" }], statusCode: 504 }),
      row({ requestId: "e", logs: [{ level: "error", message: "boom" }], statusCode: 500 }),
    ] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["error"], fetch: f });
    expect(r.ok && r.lines.map((l) => l.rowId).sort()).toEqual([`e:${messageHash("error", "boom")}`, "t:status"].sort());
  });

  it("with requests, makes one line per request that printed nothing, its level from the status", async () => {
    const f = fetchOf(json({ rows: [
      row({ requestId: "ok", logs: [], requestMethod: "GET", requestPath: "/", statusCode: 200 }),
      row({ requestId: "bad", logs: [], requestMethod: "POST", requestPath: "/login", statusCode: 400 }),
      row({ requestId: "down", logs: [], requestMethod: "GET", requestPath: "/api/x", statusCode: 504 }),
      row({ requestId: "open", logs: [], requestMethod: "GET", requestPath: "/signin", statusCode: 0 }),
      row({ requestId: "said", logs: [{ level: "info", message: "hello" }], statusCode: 200 }),
    ] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, requests: true, fetch: f });
    expect(r.ok && r.lines.map((l) => [l.rowId, l.level, l.message]).sort()).toEqual([
      ["bad:request", "warning", "POST /login → 400"],
      ["down:status", "error", "GET /api/x → 504"],
      ["ok:request", "info", "GET / → 200"],
      ["open:request", "info", "GET /signin"],
      [`said:${messageHash("info", "hello")}`, "info", "hello"],
    ].sort());
  });

  it("without requests (the collector), a request that printed nothing and didn't fail makes no line", async () => {
    const f = fetchOf(json({ rows: [row({ requestId: "bad", logs: [], statusCode: 400 })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["warning", "error"], fetch: f });
    expect(r.ok && r.lines).toEqual([]);
  });

  it("does not depend on a message's position in logs[], so a level-trimmed read gives the same ids", async () => {
    const full = fetchOf(json({ rows: [row({ logs: [{ level: "info", message: "a" }, { level: "error", message: "boom" }] })] }));
    const trimmed = fetchOf(json({ rows: [row({ logs: [{ level: "error", message: "boom" }] })] }));
    const r1 = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["error"], fetch: full });
    const r2 = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["error"], fetch: trimmed });
    expect(r1.ok && r2.ok && r1.lines.map((l) => l.rowId)).toEqual(r2.ok ? r2.lines.map((l) => l.rowId) : []);
    expect(r1.ok && r1.lines).toHaveLength(1);
  });

  it("keeps repeated identical messages in one request apart with #n", async () => {
    const f = fetchOf(json({ rows: [row({ logs: [{ level: "error", message: "retry" }, { level: "error", message: "retry" }, { level: "error", message: "retry" }, { level: "error", message: "other" }] })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    const h = messageHash("error", "retry");
    expect(r.ok && r.lines.map((l) => l.rowId)).toEqual([`req1:${h}`, `req1:${h}#1`, `req1:${h}#2`, `req1:${messageHash("error", "other")}`]);
  });

  it("does not make the 5xx line when errors aren't wanted", async () => {
    const f = fetchOf(json({ rows: [row({ logs: [], statusCode: 500 })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, levels: ["warning"], fetch: f });
    expect(r.ok && r.lines).toEqual([]);
  });

  it("skips rows without a request id or a usable timestamp, and keeps the rest", async () => {
    const f = fetchOf(json({ rows: [
      row({ requestId: undefined }), row({ requestId: "r2", timestamp: undefined }), row({ requestId: "r3", timestamp: "not a date" }), 42, null,
      row({ requestId: "ok" }),
    ] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(r.ok && r.lines.map((l) => l.rowId)).toEqual([`ok:${messageHash("error", "boom")}`]);
  });

  it("copes with missing optional fields and an unknown level", async () => {
    const f = fetchOf(json({ rows: [{ requestId: "q", timestamp: iso(1), logs: [{ message: "plain" }, { level: "weird", message: "odd" }, { level: "WARN", message: "w" }, { level: "error" }] }] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(r.ok && r.lines.map((l) => [l.rowId, l.level, l.requestMethod, l.requestPath, l.statusCode, l.source, l.deploymentId])).toEqual([
      [`q:${messageHash("info", "plain")}`, "info", null, null, null, null, null], [`q:${messageHash("info", "odd")}`, "info", null, null, null, null, null],
      [`q:${messageHash("warning", "w")}`, "warning", null, null, null, null, null],
    ]);
  });

  it("returns lines oldest first", async () => {
    const f = fetchOf(json({ rows: [row({ requestId: "new", timestamp: iso(1) }), row({ requestId: "old", timestamp: iso(30) })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(r.ok && r.lines.map((l) => l.rowId)).toEqual([`old:${messageHash("error", "boom")}`, `new:${messageHash("error", "boom")}`]);
  });

  it("gives the same row ids on an overlapping second read, so stored lines dedupe", async () => {
    const a = fetchOf(json({ rows: [row({ requestId: "a" }), row({ requestId: "b", logs: [], statusCode: 500 })] }));
    const b = fetchOf(json({ rows: [row({ requestId: "b", logs: [], statusCode: 500 }), row({ requestId: "c" })] }));
    const r1 = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: a });
    const r2 = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: b });
    const ids1 = r1.ok ? r1.lines.map((l) => l.rowId) : [];
    const ids2 = r2.ok ? r2.lines.map((l) => l.rowId) : [];
    expect(ids1.filter((id) => ids2.includes(id))).toEqual(["b:status"]);
    expect(new Set([...ids1, ...ids2]).size).toBe(3);
  });
});

describe("readRequestLogs paging", () => {
  it("follows hasMoreRows up to 3 pages and says there is more", async () => {
    const f = fetchOf(
      json({ rows: [row({ requestId: "a" })], hasMoreRows: true }), json({ rows: [row({ requestId: "b" })], hasMoreRows: true }),
      json({ rows: [row({ requestId: "c" })], hasMoreRows: true }), json({ rows: [row({ requestId: "d" })], hasMoreRows: false }),
    );
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(f).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => urlOf(f, i).searchParams.get("page"))).toEqual(["0", "1", "2"]);
    expect(r).toMatchObject({ ok: true, more: true });
    expect(r.ok && r.lines).toHaveLength(3);
  });

  it("stops when the last page says no more", async () => {
    const f = fetchOf(json({ rows: [row({ requestId: "a" })], hasMoreRows: true }), json({ rows: [row({ requestId: "b" })] }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, more: false });
  });

  it("caps the lines at maxRows, keeping the newest, and says there is more", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ requestId: `r${i}`, timestamp: iso(60 - i) }));
    const f = fetchOf(json({ rows }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, maxRows: 4, fetch: f });
    expect(r).toMatchObject({ ok: true, more: true });
    expect(r.ok && r.lines.map((l) => l.rowId)).toEqual(["r6", "r7", "r8", "r9"].map((id) => `${id}:${messageHash("error", "boom")}`));
  });

  it("stops paging once the line cap is reached", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ requestId: `r${i}` }));
    const f = fetchOf(json({ rows, hasMoreRows: true }), json({ rows }));
    await readRequestLogs(TOKEN, "t", "p", { ...range, maxRows: 5, fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("keeps the lines of earlier pages when a later page fails", async () => {
    const f = fetchOf(json({ rows: [row({ requestId: "a" })], hasMoreRows: true }), new Response("nope", { status: 502 }));
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: f });
    expect(r).toMatchObject({ ok: true, more: true });
    expect(r.ok && r.lines.map((l) => l.rowId)).toEqual([`a:${messageHash("error", "boom")}`]);
  });
});

describe("readRequestLogs failures", () => {
  it("401 and 403 are auth failures", async () => {
    for (const status of [401, 403]) {
      const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response("", { status })) });
      expect(r).toEqual({ ok: false, kind: "auth", status, error: `Vercel rejected this credential (${status}).` });
    }
  });

  it("429 is transient and carries Retry-After, or 60 s", async () => {
    const a = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response("", { status: 429, headers: { "Retry-After": "12" } })) });
    expect(a).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 12 });
    const b = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response("", { status: 429 })) });
    expect(b).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 60 });
  });

  it("400 says the range may be past retention, as a soft failure", async () => {
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response("bad", { status: 400 })) });
    expect(r).toEqual({ ok: false, kind: "transient", status: 400, error: "Vercel's log history didn't answer (400); the range may be past retention." });
  });

  it("404 and 5xx are transient with the status", async () => {
    for (const status of [404, 500, 503]) {
      const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response("", { status })) });
      expect(r).toMatchObject({ ok: false, kind: "transient", status });
      expect(!r.ok && r.error).toContain(String(status));
    }
  });

  it("a network error is transient", async () => {
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new TypeError("fetch failed")) });
    expect(r).toMatchObject({ ok: false, kind: "transient" });
  });

  it("an answer that isn't the expected JSON is a format failure, not a crash", async () => {
    for (const body of ["<html>", JSON.stringify("text"), JSON.stringify([1])]) {
      const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(new Response(body, { status: 200 })) });
      expect(r).toMatchObject({ ok: false, kind: "format" });
    }
  });

  it("an object with neither rows nor hasMoreRows is a changed format, not an empty answer", async () => {
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(json({ entries: [{ requestId: "a" }] })) });
    expect(r).toMatchObject({ ok: false, kind: "transient" });
    expect(!r.ok && r.error).toMatch(/format changed/);
    const empty = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(json({ rows: [] })) });
    expect(empty).toEqual({ ok: true, lines: [], more: false });
  });

  it("gives up after the timeout, even if the answer never comes", async () => {
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, timeoutMs: 30, fetch: hang() as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, kind: "transient" });
    expect(!r.ok && r.error).toMatch(/in time/);
  });

  it("stops when the caller's signal aborts while the request is in flight", async () => {
    const ctrl = new AbortController();
    const f = hang();
    const p = readRequestLogs(TOKEN, "t", "p", { ...range, signal: ctrl.signal, fetch: f as unknown as typeof fetch });
    await new Promise((r) => setTimeout(r, 10));
    expect(f).toHaveBeenCalledTimes(1);
    ctrl.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "transient" });
    expect(!r.ok && r.error).toMatch(/cancelled/);
  });

  it("never puts the token in a failure", async () => {
    for (const res of [new Response("", { status: 401 }), new Response("", { status: 500 }), new Response("<html>", { status: 200 })]) {
      const r = await readRequestLogs(TOKEN, "t", "p", { ...range, fetch: fetchOf(res) });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it("stops when the caller's signal aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await readRequestLogs(TOKEN, "t", "p", { ...range, signal: ctrl.signal, fetch: hang() as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, kind: "transient" });
  });
});
