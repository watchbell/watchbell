import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chat, classifyUpstreamError, models, type OpenConnection, parseResetDuration, readQuota, testGenerate, UpstreamError, upstreamMessage } from "./adapter";

// Catch-all copied from lib/security/osv.test.ts: no test can reach a real provider.
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const KEY = "AQ.test-key-0000000000000000000000";
const gemini: OpenConnection = {
  id: "p1", slug: "gemini", kind: "gemini", name: "Google Gemini", enabled: true, isDefault: true,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", secret: { apiKey: KEY }, models: [], limits: [], updatedAt: new Date(0),
};
const custom: OpenConnection = { ...gemini, id: "p2", slug: "my-llm", kind: "custom", name: "my-llm", baseUrl: "https://llm.example.com/v1", secret: { apiKey: "sk-custom-123", baseUrl: "https://llm.example.com/v1" } };
const OAI = "https://generativelanguage.googleapis.com/v1beta/openai";
const NATIVE = "https://generativelanguage.googleapis.com/v1beta";

describe("chat", () => {
  it("sends the key as x-goog-api-key, the body as given, and none of the caller's headers", async () => {
    let seen: { headers: Record<string, string>; body: unknown } | null = null;
    server.use(http.post(`${OAI}/chat/completions`, async ({ request }) => {
      seen = { headers: Object.fromEntries(request.headers), body: await request.json() };
      return HttpResponse.json({ id: "x", choices: [] });
    }));
    const res = await chat(gemini, { model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(seen!.body).toEqual({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] });
    expect(seen!.headers["x-goog-api-key"]).toBe(KEY);
    expect(seen!.headers.authorization).toBeUndefined();
    expect(seen!.headers.cookie).toBeUndefined();
    expect(seen!.headers["x-client"]).toBeUndefined();
  });
  it("custom connections get a Bearer header", async () => {
    let auth: string | null = null;
    server.use(http.post("https://llm.example.com/v1/chat/completions", ({ request }) => { auth = request.headers.get("authorization"); return HttpResponse.json({}); }));
    await chat(custom, { model: "gemini-2.5-flash" }, new AbortController().signal);
    expect(auth).toBe("Bearer sk-custom-123");
  });
  it("a custom connection saved without a key (self-host, local server) sends no Authorization header", async () => {
    const local: OpenConnection = { ...custom, baseUrl: "http://localhost:11434/v1", secret: { apiKey: "", baseUrl: "http://localhost:11434/v1" } };
    let headers: Record<string, string> | null = null;
    server.use(
      http.post("http://localhost:11434/v1/chat/completions", ({ request }) => { headers = Object.fromEntries(request.headers); return HttpResponse.json({}); }),
      http.get("http://localhost:11434/v1/models", ({ request }) => { headers = Object.fromEntries(request.headers); return HttpResponse.json({ data: [{ id: "llama3.2" }] }); }),
    );
    await chat(local, { model: "llama3.2" }, new AbortController().signal);
    expect(headers!.authorization).toBeUndefined();
    headers = null;
    expect((await models(local)).map((m) => m.id)).toEqual(["llama3.2"]);
    expect(headers!.authorization).toBeUndefined();
  });
  it("gives up after the timeout with a 504 timeout class", async () => {
    server.use(http.post(`${OAI}/chat/completions`, async () => { await delay(2_000); return HttpResponse.json({}); }));
    const err = await chat(gemini, { model: "m" }, new AbortController().signal, 50).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.info).toMatchObject({ errorClass: "timeout", status: 504, type: "upstream_error" });
  });
  it("returns upstream error answers as they are (the gateway classifies them)", async () => {
    server.use(http.post(`${OAI}/chat/completions`, () => HttpResponse.json([{ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }], { status: 429 })));
    expect((await chat(gemini, { model: "m" }, new AbortController().signal)).status).toBe(429);
  });
});

describe("classifyUpstreamError", () => {
  it("429 → quota_exceeded with Gemini's retryDelay", () => {
    const body = JSON.stringify([{ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "53s" }] } }]);
    expect(classifyUpstreamError(429, body)).toEqual({ type: "quota_exceeded", errorClass: "rate_limited", retryAfter: 53, status: 429 });
  });
  it("Google's 403 'denied access' gets its own class and the owner's message", () => {
    const c = classifyUpstreamError(403, '{"error":{"code":403,"message":"Your project has been denied access. Please contact support.","status":"PERMISSION_DENIED"}}');
    expect(c).toMatchObject({ errorClass: "project_denied", status: 502 });
    expect(upstreamMessage(c.errorClass, 403, "Google Gemini")).toBe("Google denied this project's Gemini API access. Use a key from another Google project or account.");
  });
  it("bad keys, server errors and unknown statuses; the body never comes back", () => {
    expect(classifyUpstreamError(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}').errorClass).toBe("auth_rejected");
    expect(classifyUpstreamError(401, "")).toMatchObject({ errorClass: "auth_rejected", status: 502 });
    expect(classifyUpstreamError(500, "secret stack trace sk-123")).toEqual({ type: "upstream_error", errorClass: "server_error", retryAfter: null, status: 502 });
    expect(classifyUpstreamError(400, "{}")).toMatchObject({ type: "invalid_request", status: 400 });
    expect(JSON.stringify(classifyUpstreamError(500, "secret stack trace sk-123"))).not.toContain("sk-123");
  });
});

describe("models", () => {
  it("Gemini: the native list, text models with generateContent, Gemini/Antigravity only", async () => {
    let key: string | null = null;
    server.use(http.get(`${NATIVE}/models`, ({ request }) => {
      key = request.headers.get("x-goog-api-key");
      return HttpResponse.json({ models: [
        { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
        { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
        { name: "models/antigravity-preview-latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
        { name: "models/veo-3.0-generate-001", supportedGenerationMethods: ["predictLongRunning"] },
      ] });
    }));
    expect(await models(gemini)).toEqual([
      { id: "antigravity-preview-latest", upstream: "antigravity-preview-latest" },
      { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", ctx: 1048576, out: 65536 },
    ]);
    expect(key).toBe(KEY);
  });
  it("Cloudflare: the catalogue search (Bearer token), Google Gemma only, ids without @cf/<vendor>/", async () => {
    const cf: OpenConnection = { ...custom, id: "p3", slug: "cloudflare", kind: "cloudflare", name: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1", secret: { apiKey: "cf-token", accountId: "acc" } };
    let seen: { auth: string | null; task: string | null } | null = null;
    server.use(http.get("https://api.cloudflare.com/client/v4/accounts/acc/ai/models/search", ({ request }) => {
      seen = { auth: request.headers.get("authorization"), task: new URL(request.url).searchParams.get("task") };
      return HttpResponse.json({ success: true, result: [
        { name: "@cf/google/gemma-3-12b-it", properties: [{ property_id: "context_window", value: "80000" }] },
        { name: "@cf/meta/llama-3.1-8b-instruct" },
      ] });
    }));
    expect(await models(cf)).toEqual([{ id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it", ctx: 80000 }]);
    expect(seen).toEqual({ auth: "Bearer cf-token", task: "Text Generation" });
  });
  it("custom (owner 14 Oct): every id the server's OpenAI list returns, no name filter", async () => {
    server.use(http.get("https://llm.example.com/v1/models", () => HttpResponse.json({ data: [{ id: "gemini-2.5-flash" }, { id: "llama-3.3-70b" }, { id: "kr/claude-sonnet-4.5" }, { id: "text-embedding-3" }] })));
    expect((await models(custom)).map((m) => m.upstream)).toEqual(["gemini-2.5-flash", "kr/claude-sonnet-4.5", "llama-3.3-70b", "text-embedding-3"]);
  });
  it("a rejected key throws a classified error without the body", async () => {
    server.use(http.get(`${NATIVE}/models`, () => HttpResponse.json({ error: { message: "API key not valid AIzaSECRET" } }, { status: 400 })));
    const err = await models(gemini).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.info.errorClass).toBe("auth_rejected");
    expect(err.message).not.toContain("AIzaSECRET");
  });
});

describe("testGenerate", () => {
  it("a tiny generateContent; the denied project gets the owner's message", async () => {
    server.use(http.post(`${NATIVE}/models/gemini-3.8-flash\\:generateContent`, () => HttpResponse.json({ error: { code: 403, message: "Your project has been denied access. Please contact support.", status: "PERMISSION_DENIED" } }, { status: 403 })));
    expect(await testGenerate(gemini, "gemini-3.8-flash")).toEqual({ ok: false, status: 403, errorClass: "project_denied", error: "Google denied this project's Gemini API access. Use a key from another Google project or account." });
  });
  it("ok when the model answers", async () => {
    let body: unknown = null;
    server.use(http.post(`${NATIVE}/models/gemini-3.8-flash\\:generateContent`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ candidates: [] }); }));
    expect(await testGenerate(gemini, "gemini-3.8-flash")).toMatchObject({ ok: true });
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 16 } });
  });
});

describe("readQuota", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  it("parses x-ratelimit-* headers; Gemini sends none", () => {
    const h = new Headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "998", "x-ratelimit-reset-requests": "2m59.56s", "x-ratelimit-limit-tokens": "12000", "x-ratelimit-remaining-tokens": "5790", "x-ratelimit-reset-tokens": "7.66s" });
    expect(readQuota({ id: "p2" }, "gemini-2.5-flash", h, now)).toEqual([
      { providerId: "p2", scope: "gemini-2.5-flash", metric: "requests", limit: 1000, remaining: 998, used: 2, resetAt: new Date(now.getTime() + 179_560), source: "header" },
      { providerId: "p2", scope: "gemini-2.5-flash", metric: "tokens", limit: 12000, remaining: 5790, used: 6210, resetAt: new Date(now.getTime() + 7_660), source: "header" },
    ]);
    expect(readQuota({ id: "p1" }, "gemini-3.8-flash", new Headers({ "content-type": "application/json" }), now)).toEqual([]);
  });
  it("reset durations", () => {
    expect(parseResetDuration("1h2m3s")).toBe(3_723_000);
    expect(parseResetDuration("120ms")).toBe(120);
    expect(parseResetDuration("30")).toBe(30_000);
    expect(parseResetDuration("soon")).toBeNull();
  });
});
