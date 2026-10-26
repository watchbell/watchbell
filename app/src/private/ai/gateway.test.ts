import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenConnection } from "./providers/adapter";

const h = vi.hoisted(() => ({
  auth: vi.fn(), readAgSettings: vi.fn(), resolveModel: vi.fn(), openConnections: vi.fn(), consoleDefaultModel: vi.fn(), recordCall: vi.fn(), pending: [] as Promise<unknown>[],
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => { h.pending.push(fn()); } }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("./providers/providers-db", () => ({ resolveModel: h.resolveModel, openConnections: h.openConnections, consoleDefaultModel: h.consoleDefaultModel }));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: h.readAgSettings }));
vi.mock("./usage", async (orig) => ({ ...(await orig<typeof import("./usage")>()), recordCall: h.recordCall }));

import { complete, consoleTarget, GatewayError, handleChat, handleModels, meterStream } from "./gateway";

const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const OAI = "https://generativelanguage.googleapis.com/v1beta/openai";
const conn: OpenConnection = {
  id: "p1", slug: "gemini", kind: "gemini", name: "Google Gemini", enabled: true, isDefault: true, baseUrl: OAI,
  secret: { apiKey: "AQ.secret-key-000000000000000000000" }, limits: [{ metric: "requests", scope: "all", limit: 100, window: "day" }], updatedAt: new Date(0),
  models: [{ id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true }],
};
const key = {
  keyId: "k1", name: "portfolio", prefix: "wp_7Hq2", scopes: ["ai:invoke"], ratePerMin: 20, providerId: null, model: null,
  client: { name: "portfolio-advisor", version: "1.4", via: "x-client", userAgent: "node" },
};
const req = (body: unknown, headers: Record<string, string> = {}) => new Request("https://watchpost.test/api/v1/ai/chat/completions", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wp_x", cookie: "sb=1", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const settle = async () => { await Promise.all(h.pending.splice(0)); };
const ok = { model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  h.pending.length = 0;
  h.auth.mockReset().mockResolvedValue({ ok: true, key });
  h.resolveModel.mockReset().mockResolvedValue({ conn, upstream: "gemini-3.8-flash", publicId: "gemini/gemini-3.8-flash" });
  h.openConnections.mockReset().mockResolvedValue([conn]);
  h.consoleDefaultModel.mockReset().mockResolvedValue(null);
  h.recordCall.mockReset().mockResolvedValue(undefined);
  h.readAgSettings.mockReset().mockResolvedValue({ report: null, prefs: { disabled: [], defaultModel: null }, allowed: [] });
});

describe("handleChat", () => {
  it("a failed key check answers before anything else", async () => {
    h.auth.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "invalid_api_key" } }, { status: 401 }) });
    const res = await handleChat(req(ok));
    expect(res.status).toBe(401);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "ai:invoke");
    expect(h.resolveModel).not.toHaveBeenCalled();
  });
  it("bad body → 400 naming the first issue", async () => {
    const res = await handleChat(req({ model: "gemini-3.8-flash", messages: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { type: "invalid_request", message: expect.stringMatching(/^messages: /) } });
    expect((await handleChat(req("{nope"))).status).toBe(400);
    expect((await handleChat(req({ ...ok, n: 2 }))).status).toBe(400);
  });
  it("no provider → 503; disabled model → 400", async () => {
    h.resolveModel.mockResolvedValueOnce("provider_not_connected").mockResolvedValueOnce("model_not_enabled");
    const a = await handleChat(req(ok));
    expect(a.status).toBe(503);
    expect((await a.json()).error.type).toBe("provider_not_connected");
    const b = await handleChat(req(ok));
    expect(b.status).toBe(400);
    expect((await b.json()).error.type).toBe("model_not_enabled");
    await settle();
    expect(h.recordCall).toHaveBeenCalledTimes(2);
  });
  it("routes with the key's pin", async () => {
    h.auth.mockResolvedValue({ ok: true, key: { ...key, providerId: "p1", model: "gemini/gemini-3.8-flash" } });
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ choices: [] })));
    await handleChat(req({ ...ok, model: "gemini-2.5-pro" }));
    expect(h.resolveModel).toHaveBeenCalledWith("gemini-2.5-pro", { providerId: "p1", model: "gemini/gemini-3.8-flash" });
  });
  it("forwards only allow-listed fields with the upstream model, no caller headers; records usage once", async () => {
    let seen: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    server.use(http.post(`${OAI}/chat/completions`, async ({ request }) => {
      seen = { body: (await request.json()) as Record<string, unknown>, headers: Object.fromEntries(request.headers) };
      return HttpResponse.json({ id: "c1", model: "gemini-3.8-flash", choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    }));
    const res = await handleChat(req({ ...ok, temperature: 0.2, stop: null, metadata: { secret: 1 } }, { "x-client": "portfolio-advisor/1.4" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ model: "gemini/gemini-3.8-flash", choices: [{ message: { content: "hello" } }] });
    expect(seen!.body).toEqual({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
    expect(seen!.headers.cookie).toBeUndefined();
    expect(seen!.headers.authorization).toBeUndefined();
    expect(seen!.headers["x-client"]).toBeUndefined();
    await settle();
    expect(h.recordCall).toHaveBeenCalledTimes(1);
    const [rec, quota] = h.recordCall.mock.calls[0];
    expect(rec).toMatchObject({ keyId: "k1", providerId: "p1", model: "gemini/gemini-3.8-flash", kind: "chat", status: 200, tokensIn: 12, tokensOut: 3, stream: false, errorClass: null });
    expect(JSON.stringify(rec)).not.toContain("hello");
    expect(JSON.stringify(rec)).not.toContain("\"hi\"");
    expect(quota).toEqual([expect.objectContaining({ providerId: "p1", metric: "requests:day", used: 1, source: "own" })]);
  });
  it("upstream 429 → quota_exceeded with Retry-After; upstream bodies are never echoed", async () => {
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json([{ error: { code: 429, message: "quota sk-leak", details: [{ retryDelay: "17s" }] } }], { status: 429 })));
    const res = await handleChat(req(ok));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    const text = await res.text();
    expect(JSON.parse(text).error.type).toBe("quota_exceeded");
    expect(text).not.toContain("sk-leak");
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.text("Traceback secret-internal", { status: 500 })));
    const res2 = await handleChat(req(ok));
    expect(res2.status).toBe(502);
    expect(await res2.text()).not.toContain("secret-internal");
    await settle();
    expect(h.recordCall.mock.calls.map((c) => c[0].errorClass)).toEqual(["quota_exceeded · rate_limited", "upstream_error · server_error"]);
  });
  it("stream: identical bytes, usage requested and recorded once after the stream closed", async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"id":"1","choices":[],"usage":{"prompt_tokens":9,',
      '"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ];
    let sent: Record<string, unknown> | null = null;
    server.use(http.post(`${OAI}/chat/completions`, async ({ request }) => {
      sent = (await request.json()) as Record<string, unknown>;
      const enc = new TextEncoder();
      return new HttpResponse(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }));
    const res = await handleChat(req({ ...ok, stream: true }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(sent!.stream_options).toEqual({ include_usage: true });
    expect(await res.text()).toBe(chunks.join(""));
    await settle();
    expect(h.recordCall).toHaveBeenCalledTimes(1);
    expect(h.recordCall.mock.calls[0][0]).toMatchObject({ status: 200, stream: true, tokensIn: 9, tokensOut: 2 });
  });
});

describe("meterStream", () => {
  it("a client that goes away is recorded as aborted", async () => {
    const up = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); } });
    const m = meterStream(up);
    const reader = m.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(await m.done).toEqual({ usage: null, end: "aborted" });
  });
});

describe("complete (console)", () => {
  it("uses the default model, records as the console with no key, returns text only", async () => {
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ choices: [{ message: { content: "Roll back first." } }], usage: { prompt_tokens: 40, completion_tokens: 5 } })));
    const r = await complete([{ role: "user", content: "why down?" }], { purpose: "ask-ai" });
    expect(r).toMatchObject({ text: "Roll back first.", model: "gemini/gemini-3.8-flash", usage: { in: 40, out: 5 } });
    await settle();
    expect(h.recordCall.mock.calls[0][0]).toMatchObject({ keyId: null, kind: "console", client: { name: "watchpost-console", via: "console" } });
  });
  it("timeoutMs limits the upstream call (Patroli's rooms); without it the adapter's 60 s default", async () => {
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ choices: [{ message: { content: "ok" } }] })));
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await complete([{ role: "user", content: "x" }], { purpose: "office-patrol", timeoutMs: 12_345 });
      expect(spy).toHaveBeenLastCalledWith(12_345);
      await complete([{ role: "user", content: "x" }], { purpose: "ask-ai" });
      expect(spy).toHaveBeenLastCalledWith(60_000);
    } finally {
      spy.mockRestore();
    }
  });
  it("falls back once to another enabled provider when the first is down (5xx), and never for a pinned model", async () => {
    const backup: OpenConnection = { ...conn, id: "p9", slug: "backup", kind: "custom", name: "Backup", isDefault: false, baseUrl: "https://backup.example/v1", models: [{ id: "b-1", upstream: "b-1", enabled: true }] };
    h.openConnections.mockResolvedValue([conn, backup]);
    server.use(
      http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ error: { message: "down" } }, { status: 503 })),
      http.post("https://backup.example/v1/chat/completions", () => HttpResponse.json({ choices: [{ message: { content: "from backup" } }] })),
    );
    const r = await complete([{ role: "user", content: "x" }], { purpose: "office-patrol" });
    expect(r.text).toBe("from backup");
    h.resolveModel.mockResolvedValue({ conn, upstream: "gemini-3.8-flash", publicId: "gemini/gemini-3.8-flash" });
    await expect(complete([{ role: "user", content: "x" }], { purpose: "office-patrol", model: "gemini/gemini-3.8-flash" })).rejects.toBeInstanceOf(GatewayError);
  });
  it("does not fall back on a 4xx about the request itself, nor when no other provider has a model on", async () => {
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ error: { message: "bad" } }, { status: 400 })));
    await expect(complete([{ role: "user", content: "x" }], { purpose: "summary" })).rejects.toBeInstanceOf(GatewayError);
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json({ error: { message: "down" } }, { status: 503 })));
    await expect(complete([{ role: "user", content: "x" }], { purpose: "summary" })).rejects.toBeInstanceOf(GatewayError);
  });
  it("no provider → a GatewayError the UI can show", async () => {
    h.openConnections.mockResolvedValue([]);
    await expect(complete([{ role: "user", content: "x" }], { purpose: "summary" })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("complete: fallback and plain errors (owner item #19)", () => {
  // The office's call: a preferred model on the default connection (officeModel) with fallback allowed.
  const router: OpenConnection = {
    ...conn, id: "r1", slug: "my-router", kind: "custom", name: "my-router", isDefault: true, baseUrl: "https://my-router.example/v1",
    secret: { apiKey: "sk-router-000000", baseUrl: "https://my-router.example/v1" }, models: [{ id: "llama-3.3", upstream: "llama-3.3", enabled: true }],
  };
  const backup: OpenConnection = { ...router, id: "b1", slug: "backup", name: "Backup", isDefault: false, baseUrl: "https://backup.example/v1", models: [{ id: "b-1", upstream: "b-1", enabled: true }] };
  const off: OpenConnection = { ...backup, id: "o1", slug: "switched-off", name: "Switched off", enabled: false, baseUrl: "https://off.example/v1" };
  const office = { model: "my-router/llama-3.3", fallback: true, purpose: "office-dev" as const, timeoutMs: 40_000 };
  const msgs = [{ role: "user" as const, content: "x" }];
  const hits = { router: 0, backup: 0, off: 0 };
  const routerAnswers = (status: number) => http.post("https://my-router.example/v1/chat/completions", () => { hits.router++; return HttpResponse.text("<html>origin down</html>", { status }); });
  const backupAnswers = (r: () => Response) => http.post("https://backup.example/v1/chat/completions", () => { hits.backup++; return r(); });
  const offAnswers = http.post("https://off.example/v1/chat/completions", () => { hits.off++; return HttpResponse.json({ choices: [{ message: { content: "never" } }] }); });
  const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as GatewayError; } throw new Error("expected a GatewayError"); };

  beforeEach(() => {
    hits.router = 0; hits.backup = 0; hits.off = 0;
    h.openConnections.mockResolvedValue([router, off, backup]);
    h.resolveModel.mockResolvedValue({ conn: router, upstream: "llama-3.3", publicId: "my-router/llama-3.3" });
  });

  it("530 → the next enabled provider answers (never the switched-off one) and is recorded as the one that answered", async () => {
    server.use(routerAnswers(530), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "from backup" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })), offAnswers);
    const r = await complete(msgs, office);
    expect(r).toMatchObject({ text: "from backup", model: "backup/b-1" });
    expect(hits).toEqual({ router: 1, backup: 1, off: 0 });
    await settle();
    expect(h.recordCall.mock.calls.map((c) => [c[0].providerId, c[0].status, c[0].errorClass])).toEqual([["r1", 502, "upstream_error · server_error"], ["b1", 200, null]]);
  });
  it("530 with no other enabled provider → the plain message naming the provider and the page", async () => {
    h.openConnections.mockResolvedValue([router, off]);
    server.use(routerAnswers(530), offAnswers);
    const e = await failure(complete(msgs, office));
    expect(e).toBeInstanceOf(GatewayError);
    expect(e.message).toBe('AI provider "my-router" is unreachable (its endpoint or tunnel is down). No other provider is enabled: add one on Bring your own key (/ai/providers), or check the endpoint.');
    expect(e.status).toBe(502);
    expect(e.failure).toEqual({ first: expect.objectContaining({ provider: "my-router", status: 530, errorClass: "server_error" }), next: { kind: "none" } });
    expect(hits.off).toBe(0);
  });
  it("a network failure (tunnel gone, DNS, refused) is unreachable too and falls back", async () => {
    server.use(http.post("https://my-router.example/v1/chat/completions", () => { hits.router++; return HttpResponse.error(); }), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "ok" } }] })));
    await expect(complete(msgs, office)).resolves.toMatchObject({ text: "ok", model: "backup/b-1" });
    expect(hits).toMatchObject({ router: 1, backup: 1 });
  });
  it("401 → no fallback; the message says the key was refused", async () => {
    server.use(routerAnswers(401), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "never" } }] })));
    const e = await failure(complete(msgs, office));
    expect(e.message).toBe('AI provider "my-router" refused the key (401). Replace it on Bring your own key (/ai/providers).');
    expect(hits).toMatchObject({ router: 1, backup: 0 });
    server.use(routerAnswers(400));
    await failure(complete(msgs, office));
    expect(hits.backup).toBe(0);
  });
  it("the fallback fails too → the message names both providers", async () => {
    server.use(routerAnswers(530), backupAnswers(() => HttpResponse.json({ error: { message: "sk-leak" } }, { status: 503 })));
    const e = await failure(complete(msgs, office));
    expect(e.message).toBe('AI provider "my-router" is unreachable (its endpoint or tunnel is down). Tried "Backup" instead, and that failed too (unreachable).');
    expect(e.failure?.next).toEqual({ kind: "tried", fallback: expect.objectContaining({ provider: "Backup", status: 503 }) });
    expect(JSON.stringify(e.failure)).not.toContain("sk-leak");
    expect(e.message).not.toContain("example");
  });
  it("a pinned model (no fallback flag) is never moved; the message says why", async () => {
    server.use(routerAnswers(530), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "never" } }] })));
    const e = await failure(complete(msgs, { model: "my-router/llama-3.3", purpose: "playground" }));
    expect(e.message).toContain("This model was picked by name, so no other provider was tried");
    expect(hits.backup).toBe(0);
  });
  it("no fallback once the caller's time limit is nearly spent", async () => {
    server.use(http.post("https://my-router.example/v1/chat/completions", async () => { hits.router++; await new Promise((r) => setTimeout(r, 60)); return new HttpResponse(null, { status: 530 }); }), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "never" } }] })));
    const e = await failure(complete(msgs, { ...office, timeoutMs: 3_050 }));
    expect(e.message).toMatch(/There was no time left to try another provider\.$/);
    expect(hits.backup).toBe(0);
  });
  it("a provider that hangs: the first try gets 2/3 of the time limit, so the fallback still fits in the same limit", async () => {
    // the first try's own timeout fires (an already-timed-out signal stands in for the hang)
    server.use(routerAnswers(200), backupAnswers(() => HttpResponse.json({ choices: [{ message: { content: "from backup" } }] })), offAnswers);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")));
    try {
      const r = await complete(msgs, { ...office, timeoutMs: 30_000 });
      expect(r).toMatchObject({ text: "from backup", model: "backup/b-1" });
      const [firstMs, secondMs] = spy.mock.calls.map((c) => c[0]);
      expect(firstMs).toBe(20_000);
      expect(secondMs).toBeGreaterThan(20_000);
      expect(secondMs).toBeLessThanOrEqual(30_000); // never beyond the caller's own limit
    } finally {
      spy.mockRestore();
    }
    await settle();
    expect(h.recordCall.mock.calls[0][0]).toMatchObject({ providerId: "r1", errorClass: "upstream_error · timeout" });
  });
  it("the time limit is not shared when nothing else could answer: a pinned model, or no other enabled provider", async () => {
    server.use(http.post("https://my-router.example/v1/chat/completions", () => HttpResponse.json({ choices: [{ message: { content: "ok" } }] })));
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await complete(msgs, { model: "my-router/llama-3.3", purpose: "playground", timeoutMs: 30_000 });
      expect(spy).toHaveBeenLastCalledWith(30_000);
      h.openConnections.mockResolvedValue([router, off]);
      await complete(msgs, { ...office, timeoutMs: 30_000 });
      expect(spy).toHaveBeenLastCalledWith(30_000);
    } finally {
      spy.mockRestore();
    }
  });
  it("the share starts at a 9 s limit: below it the first try keeps the whole limit; without a limit, the adapter's 60 s", async () => {
    server.use(http.post("https://my-router.example/v1/chat/completions", () => HttpResponse.json({ choices: [{ message: { content: "ok" } }] })));
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await complete(msgs, { ...office, timeoutMs: 8_000 }); // backup enabled, but a third (2 666 ms) is under 3 s
      expect(spy).toHaveBeenLastCalledWith(8_000);
      await complete(msgs, { ...office, timeoutMs: 9_000 }); // the boundary: 6 s first, 3 s kept for the fallback
      expect(spy).toHaveBeenLastCalledWith(6_000);
      await complete(msgs, { model: office.model, fallback: true, purpose: office.purpose });
      expect(spy).toHaveBeenLastCalledWith(60_000);
    } finally {
      spy.mockRestore();
    }
  });
  it("the default model (no model given) falls back as before, with the plain message when there is none", async () => {
    h.openConnections.mockResolvedValue([router]);
    server.use(routerAnswers(522));
    const e = await failure(complete(msgs, { purpose: "summary" }));
    expect(e.message).toMatch(/^AI provider "my-router" is unreachable/);
  });
});

describe("consoleTarget (owner's ai.defaultModel)", () => {
  const two: OpenConnection = { ...conn, models: [{ id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true }, { id: "gemini-2.5-pro", upstream: "gemini-2.5-pro", enabled: true }, { id: "gemini-3.1-pro-preview", upstream: "gemini-3.1-pro-preview", enabled: false }] };
  const cf: OpenConnection = {
    ...conn, id: "p2", slug: "cloudflare", kind: "cloudflare", name: "Workers AI", isDefault: false, baseUrl: "https://api.cloudflare.com/client/v4/accounts/a/ai/v1",
    models: [{ id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it", enabled: true }, { id: "llama-3.1-8b", upstream: "@cf/meta/llama-3.1-8b-instruct", enabled: true }],
  };

  it("without a setting: the default connection's own pick", async () => {
    h.openConnections.mockResolvedValue([two]);
    await expect(consoleTarget()).resolves.toMatchObject({ upstream: "gemini-3.8-flash", publicId: "gemini/gemini-3.8-flash" });
  });
  it("uses ai.defaultModel when the model is on and its provider connected, even on a non-default provider", async () => {
    h.openConnections.mockResolvedValue([two, cf]);
    h.consoleDefaultModel.mockResolvedValue("gemini/gemini-2.5-pro");
    await expect(consoleTarget()).resolves.toMatchObject({ upstream: "gemini-2.5-pro", publicId: "gemini/gemini-2.5-pro" });
    h.consoleDefaultModel.mockResolvedValue("cloudflare/gemma-3-12b-it");
    await expect(consoleTarget()).resolves.toMatchObject({ conn: { id: "p2" }, upstream: "@cf/google/gemma-3-12b-it" });
  });
  it("ignores ai.defaultModel when the model is off, not allowed, or its provider is gone or disabled", async () => {
    for (const [conns, setting] of [
      [[two], "gemini/gemini-3.1-pro-preview"], // turned off
      [[two, cf], "cloudflare/llama-3.1-8b"], // not on the gateway allowlist
      [[two], "cloudflare/gemma-3-12b-it"], // provider not connected
      [[two, { ...cf, enabled: false }], "cloudflare/gemma-3-12b-it"], // provider switched off
      [[two], "claude-sonnet-4-6"], // no Anthropic provider
    ] as const) {
      h.openConnections.mockResolvedValue([...conns]);
      h.consoleDefaultModel.mockResolvedValue(setting);
      await expect(consoleTarget(), setting).resolves.toMatchObject({ conn: { id: "p1" }, upstream: "gemini-3.8-flash" });
    }
  });
  it("an explicit model still wins over the setting", async () => {
    h.consoleDefaultModel.mockResolvedValue("gemini/gemini-2.5-pro");
    await consoleTarget("gemini/gemini-3.8-flash");
    expect(h.resolveModel).toHaveBeenCalledWith("gemini/gemini-3.8-flash", null);
    expect(h.consoleDefaultModel).not.toHaveBeenCalled();
  });
});

describe("manual model ids (custom connection)", () => {
  const test: OpenConnection = {
    ...conn, id: "p3", slug: "test", kind: "custom", name: "test", baseUrl: "https://llm.example.com/v1", secret: { apiKey: "sk-x", baseUrl: "https://llm.example.com/v1" },
    models: [
      { id: "llama-3.3", upstream: "llama-3.3", enabled: true },
      { id: "prrojects", upstream: "prrojects", enabled: true, manual: true },
      { id: "off-combo", upstream: "off-combo", enabled: false, manual: true },
    ],
  };
  it("are listed by /api/v1/ai/models, and so is every listed model of a custom server (owner 14 Oct)", async () => {
    h.openConnections.mockResolvedValue([{ ...conn, isDefault: false }, { ...test, isDefault: true }]);
    const res = await handleModels(new Request("https://watchpost.test/api/v1/ai/models", { headers: { authorization: "Bearer wp_x" } }));
    await settle();
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["gemini/gemini-3.8-flash", "test/llama-3.3", "test/prrojects"]);
  });
  it("the console can use one: as its default connection's pick and as ai.defaultModel", async () => {
    h.openConnections.mockResolvedValue([{ ...test, isDefault: true, models: test.models.filter((m) => m.manual) }]);
    await expect(consoleTarget()).resolves.toMatchObject({ conn: { id: "p3" }, upstream: "prrojects", publicId: "test/prrojects" });
    h.openConnections.mockResolvedValue([conn, { ...test, isDefault: false }]);
    h.consoleDefaultModel.mockResolvedValue("test/prrojects");
    await expect(consoleTarget()).resolves.toMatchObject({ conn: { id: "p3" }, upstream: "prrojects" });
  });
});
