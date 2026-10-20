import { describe, expect, it } from "vitest";
import { opById } from "@/private/openapi/operations";
import { applyExample, buildRequest, describeResponse, initialBuilder, sizeText, statusTone, statusWord } from "./request";

const KEY = "wp_" + "A".repeat(40);
const origin = "https://watch.example.com";
const op = (id: string) => opById(id)!;

describe("initialBuilder", () => {
  it("starts from the operation: X-Client header, empty required params, the body example", () => {
    const b = initialBuilder(op("ai-chat"));
    expect(b.headers).toEqual([{ name: "X-Client", value: "api-explorer" }]);
    expect(JSON.parse(b.body).model).toBe("gemini/gemini-3.8-flash");
    expect(initialBuilder(op("advice")).query).toEqual([{ name: "app", value: "" }]);
    expect(initialBuilder(op("status-app")).path).toEqual({ app: "" });
    expect(initialBuilder(op("mcp")).headers.map((h) => h.name)).toEqual(["Accept", "MCP-Protocol-Version", "X-Client"]);
  });
});

describe("applyExample", () => {
  it("sets the named query value and goes back to the start for everything else", () => {
    const b = applyExample(op("status"), { query: { include: "alerts" } });
    expect(b.query).toEqual([{ name: "include", value: "alerts" }]);
    expect(b.headers).toEqual([{ name: "X-Client", value: "api-explorer" }]);
  });
  it("adds names the operation doesn't list, and replaces the body", () => {
    const b = applyExample(op("mcp"), { headers: { "Mcp-Session-Id": "s1" }, body: "{}" });
    expect(b.headers.at(-1)).toEqual({ name: "Mcp-Session-Id", value: "s1" });
    expect(b.body).toBe("{}");
  });
});

describe("buildRequest", () => {
  it("builds a relative path with encoded path params and only the filled query values", () => {
    const b = { ...initialBuilder(op("status-app")), path: { app: "my app/1" } };
    const r = buildRequest(op("status-app"), b, KEY, origin);
    expect(r).toMatchObject({ ok: true, request: { method: "GET", path: "/api/v1/status/apps/my%20app%2F1", url: `${origin}/api/v1/status/apps/my%20app%2F1`, body: undefined } });
    const s = buildRequest(op("status"), { ...initialBuilder(op("status")), query: [{ name: "include", value: " apps,alerts " }, { name: "", value: "x" }, { name: "empty", value: "" }] }, KEY, origin);
    expect(s).toMatchObject({ ok: true, request: { path: "/api/v1/status?include=apps%2Calerts" } });
  });

  it("sends the key only as a bearer header, and only for endpoints that take one", () => {
    const withKey = buildRequest(op("me"), initialBuilder(op("me")), `  ${KEY} `, origin);
    expect(withKey.ok && withKey.request.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "X-Client": "api-explorer" });
    const health = buildRequest(op("health"), initialBuilder(op("health")), KEY, origin);
    expect(health.ok && Object.keys(health.request.headers)).toEqual([]);
    const ping = buildRequest(op("ping"), { ...initialBuilder(op("ping")), path: { token: "hb_" + "0".repeat(32) } }, KEY, origin);
    expect(ping.ok && ping.request.headers.Authorization).toBeUndefined();
    expect(ping.ok && ping.request.method).toBe("POST");
  });

  it("asks for a key, required params and a valid body before sending anything", () => {
    expect(buildRequest(op("status"), initialBuilder(op("status")), "", origin)).toEqual({ ok: false, error: "Paste a console API key first (this endpoint needs read:status)." });
    expect(buildRequest(op("me"), initialBuilder(op("me")), "", origin)).toEqual({ ok: false, error: "Paste a console API key first." });
    expect(buildRequest(op("status-app"), initialBuilder(op("status-app")), KEY, origin)).toEqual({ ok: false, error: "Fill in the path parameter app." });
    expect(buildRequest(op("advice"), initialBuilder(op("advice")), KEY, origin)).toEqual({ ok: false, error: "Fill in the query parameter app." });
    const bad = buildRequest(op("ai-chat"), { ...initialBuilder(op("ai-chat")), body: "{ nope" }, KEY, origin);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^The body isn't valid JSON/);
    expect(buildRequest(op("ai-chat"), { ...initialBuilder(op("ai-chat")), body: "  " }, KEY, origin)).toEqual({ ok: false, error: "The JSON body is empty." });
    expect(buildRequest(op("me"), initialBuilder(op("me")), "wp_ bad key", origin).ok).toBe(false);
  });

  it("sets a JSON content type for a body and sends the body as typed", () => {
    const r = buildRequest(op("ai-chat"), initialBuilder(op("ai-chat")), KEY, origin);
    expect(r.ok && r.request.headers["Content-Type"]).toBe("application/json");
    expect(r.ok && r.request.body).toBe(op("ai-chat").body);
  });

  it("refuses an Authorization or Cookie header row: the key field is the only way in", () => {
    for (const name of ["Authorization", "cookie", "Host"]) {
      const b = { ...initialBuilder(op("me")), headers: [{ name, value: "x" }] };
      expect(buildRequest(op("me"), b, KEY, origin).ok, name).toBe(false);
    }
    expect(buildRequest(op("me"), { ...initialBuilder(op("me")), headers: [{ name: "bad name", value: "x" }] }, KEY, origin).ok).toBe(false);
    expect(buildRequest(op("me"), { ...initialBuilder(op("me")), headers: [{ name: "X-A", value: "é" }] }, KEY, origin).ok).toBe(false);
  });
});

describe("describeResponse", () => {
  const base = { status: 200, statusText: "OK", headers: [["x-b", "2"], ["content-type", "application/json"], ["a", "1"]] as [string, string][], ms: 12.4 };
  it("pretty-prints JSON, counts bytes and sorts headers", () => {
    const r = describeResponse({ ...base, text: '{"a":1,"b":[1,2]}' });
    expect(r.body).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(r).toMatchObject({ status: 200, tone: "ok", ms: 12, bytes: 17, truncated: false });
    expect(r.headers.map(([n]) => n)).toEqual(["a", "content-type", "x-b"]);
  });
  it("keeps text and event streams as they came, and counts multi-byte characters", () => {
    expect(describeResponse({ ...base, headers: [["content-type", "text/event-stream"]], text: "data: {\"a\":1}\n\ndata: [DONE]\n\n" }).body).toBe("data: {\"a\":1}\n\ndata: [DONE]\n\n");
    expect(describeResponse({ ...base, headers: [], text: "OK é" }).bytes).toBe(5);
  });
  it("cuts a huge body for display and says so", () => {
    const r = describeResponse({ ...base, headers: [], text: "x".repeat(250_000) });
    expect(r.truncated).toBe(true);
    expect(r.body).toHaveLength(200_000);
  });
  it("tones: 2xx ok, 3xx warn, 4xx and 5xx err", () => {
    expect([200, 204, 301, 401, 429, 502].map(statusTone)).toEqual(["ok", "ok", "warn", "err", "err", "err"]);
  });
  it("formats sizes", () => {
    expect([sizeText(512), sizeText(2048)]).toEqual(["512 B", "2.0 KB"]);
  });
});

describe("statusWord", () => {
  it("uses the server's reason phrase, else a known one, else the bare code", () => {
    expect(statusWord(200, "")).toBe("200 OK");
    expect(statusWord(418, "I'm a teapot")).toBe("418 I'm a teapot");
    expect(statusWord(499, "")).toBe("499");
    expect(statusWord(429, "")).toBe("429 Too Many Requests");
  });
});
