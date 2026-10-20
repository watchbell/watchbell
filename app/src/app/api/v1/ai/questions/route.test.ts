import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/private/api/respond";

const h = vi.hoisted(() => ({
  auth: vi.fn(), enqueue: vi.fn(), questionForKey: vi.fn(), recordApiCall: vi.fn(), loadAskContext: vi.fn(), answerWithProvider: vi.fn(), storeAnswered: vi.fn(),
}));
vi.mock("@/private/assist/provider-answer", () => ({ loadAskContext: h.loadAskContext, answerWithProvider: h.answerWithProvider, WATCHPOST_CLIENT: "watchpost" }));
vi.mock("@/private/ai/usage", () => ({ recordApiCall: h.recordApiCall }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/private/assist/questions-db", () => ({ enqueue: h.enqueue, questionForKey: h.questionForKey, storeAnswered: h.storeAnswered }));

import { GET } from "./[id]/route";
import { POST } from "./route";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const key = { keyId: "key-1", name: "laptop", prefix: "wp_abcd", scopes: ["ai:invoke"], ratePerMin: 20, providerId: null, model: null, client: { name: "x", version: "", via: "unknown", userAgent: "" } };
const ORIGIN = "https://watch.example.com";
const post = (body: string, headers: Record<string, string> = {}) =>
  POST(new Request(`${ORIGIN}/api/v1/ai/questions`, { method: "POST", body, headers: { authorization: "Bearer wp_x", "content-type": "application/json", ...headers } }));
const get = (id: string) => GET(new Request(`${ORIGIN}/api/v1/ai/questions/${id}`, { headers: { authorization: "Bearer wp_x" } }), { params: Promise.resolve({ id }) });
const ASKED = new Date("2026-10-13T07:40:00.000Z");
const q = { id: ID, status: "pending", question: "Anything expiring?", answer: null, client: null, model: null, requestedModel: null as string | null, createdAt: ASKED, answeredAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ ok: true, key });
  h.enqueue.mockResolvedValue({ ok: true, id: ID, reused: false });
  h.questionForKey.mockResolvedValue(q);
  // These older cases run with no provider and Antigravity connected: Default goes to the inbox.
  h.loadAskContext.mockResolvedValue({ agConnected: true, agEnabled: ["gemini-3.8-flash-high", "gpt-oss-120b-medium"], providerReady: false });
  h.answerWithProvider.mockResolvedValue({ text: "Nothing expires this week.", model: "test/prrojects", ms: 24000 });
  h.storeAnswered.mockResolvedValue({ id: ID });
});

describe("auth: a console key with ai:invoke", () => {
  it.each([["POST", () => post('{"question":"hi"}')], ["GET", () => get(ID)]])("%s passes 401 and 403 through and touches nothing", async (_m, call) => {
    for (const [type, status] of [["invalid_api_key", 401], ["missing_scope", 403], ["key_rate_limit", 429]] as const) {
      h.auth.mockResolvedValue({ ok: false, response: apiError(type, "no", status) });
      const r = await call();
      expect(r.status).toBe(status);
      expect((await r.json()).error.type).toBe(type);
    }
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "ai:invoke");
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.questionForKey).not.toHaveBeenCalled();
    expect(h.recordApiCall).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/ai/questions", () => {
  it("answers 202 with the id, pending, the time and where to poll, and queues a general question owned by the key", async () => {
    const r = await post('{"question":"  Anything expiring this week?  "}');
    expect(r.status).toBe(202);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body).toEqual({ id: ID, status: "pending", askedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), requestedModel: null, pollUrl: `${ORIGIN}/api/v1/ai/questions/${ID}` });
    expect(r.headers.get("location")).toBe(body.pollUrl);
    expect(h.enqueue).toHaveBeenCalledWith({ kind: "general", contextId: null, question: "Anything expiring this week?", by: "key-1", now: expect.any(Date), model: null });
    expect(h.answerWithProvider).not.toHaveBeenCalled();
    expect(h.recordApiCall).toHaveBeenCalledWith(key, "status", "ai/questions", expect.any(Number), 202);
  });
  it("gives the waiting question's own time when the same question is asked again", async () => {
    h.enqueue.mockResolvedValue({ ok: true, id: ID, reused: true });
    const body = await (await post('{"question":"Anything expiring?"}')).json();
    expect(body.askedAt).toBe(ASKED.toISOString());
  });
  it.each([
    ["not JSON", "question=hi", 'Send JSON: {"question": "..."}.'],
    ["an array", "[]", 'Send JSON: {"question": "..."}.'],
    ["no question", "{}", "Type a question first."],
    ["a blank question", '{"question":"   "}', "Type a question first."],
    ["a number", '{"question":42}', "Type a question first."],
    ["too long", JSON.stringify({ question: "x".repeat(2001) }), "A question can be up to 2000 characters."],
  ])("answers 400 invalid_request for %s", async (_n, body, message) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { type: "invalid_request", message } });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("refuses a question carrying a key or token, and stores nothing", async () => {
    for (const question of ["why does wp_AbCdEf1234567890 fail", "Authorization: Bearer abcdefghijklmnopqrst", "postgres://u:pw@db.example.com/x"]) {
      const r = await post(JSON.stringify({ question }));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: { type: "invalid_request", message: "That looks like a key or token. Remove it before sending." } });
    }
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("answers 413 for a body far larger than any question", async () => {
    const r = await post(JSON.stringify({ question: "x".repeat(40_000) }));
    expect(r.status).toBe(413);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("answers 429 quota_exceeded when 20 questions already wait", async () => {
    h.enqueue.mockResolvedValue({ ok: false, error: "20 questions are already waiting for Antigravity. Let it answer some first." });
    const r = await post('{"question":"hi"}');
    expect(r.status).toBe(429);
    expect((await r.json()).error).toEqual({ type: "quota_exceeded", message: "20 questions are already waiting for Antigravity. Let it answer some first." });
  });
  it("answers 502 without the failure's text when the inbox can't be written", async () => {
    h.enqueue.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const r = await post('{"question":"hi"}');
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("10.0.0.1");
  });
});

describe("GET /api/v1/ai/questions/{id}", () => {
  it("answers a pending question with no answer yet", async () => {
    const r = await get(ID);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: ID, status: "pending", question: "Anything expiring?", requestedModel: null, answer: null, answeredBy: null, askedAt: ASKED.toISOString(), answeredAt: null });
    expect(h.questionForKey).toHaveBeenCalledWith(ID, "key-1", expect.any(Date));
    expect(h.recordApiCall).toHaveBeenCalledWith(key, "status", "ai/questions/{id}", expect.any(Number), 200);
  });
  it("answers an answered question with the answer and who wrote it", async () => {
    const at = new Date("2026-10-13T07:41:30.000Z");
    h.questionForKey.mockResolvedValue({ ...q, status: "answered", answer: "**Nothing** expires.", client: "antigravity/1.4", model: "gemini-3.8-flash-high", answeredAt: at });
    expect(await (await get(ID)).json()).toEqual({
      id: ID, status: "answered", question: "Anything expiring?", requestedModel: null, answer: "**Nothing** expires.",
      answeredBy: { client: "antigravity/1.4", model: "gemini-3.8-flash-high" }, askedAt: ASKED.toISOString(), answeredAt: at.toISOString(),
    });
  });
  it("answers an expired question without an answer", async () => {
    h.questionForKey.mockResolvedValue({ ...q, status: "expired" });
    expect(await (await get(ID)).json()).toMatchObject({ status: "expired", answer: null, answeredBy: null, answeredAt: null });
  });
  it("answers 404 for a question this key didn't ask (or an unknown one)", async () => {
    h.questionForKey.mockResolvedValue(null);
    const r = await get(ID);
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("not_found");
  });
  it("answers 404 for an id that isn't a uuid, without reading", async () => {
    for (const id of ["nope", "1", `${ID}x`, "../me"]) expect((await get(id)).status, id).toBe(404);
    expect(h.questionForKey).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/ai/questions with an Antigravity model", () => {
  it("queues an enabled model, as ag/<id> or the bare id, and echoes it", async () => {
    for (const m of ["ag/gemini-3.8-flash-high", "gemini-3.8-flash-high"]) {
      const r = await post(JSON.stringify({ question: "Hi?", model: m }));
      expect(r.status).toBe(202);
      expect((await r.json()).requestedModel).toBe("ag/gemini-3.8-flash-high");
      expect(h.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gemini-3.8-flash-high" }));
    }
  });
  it("answers 400 for an ag/ model that is off or when Antigravity isn't connected, and for a non-string model", async () => {
    for (const m of ["ag/claude-sonnet-4-6", 42]) {
      const r = await post(JSON.stringify({ question: "Hi?", model: m }));
      expect(r.status, String(m)).toBe(400);
    }
    h.loadAskContext.mockResolvedValue({ agConnected: false, agEnabled: [], providerReady: true });
    const r = await post(JSON.stringify({ question: "Hi?", model: "ag/gemini-3.8-flash-high" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { type: "invalid_request", message: "That model isn't available. See GET /api/v1/ai/models." } });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("GET returns the requested model as ag/<id>", async () => {
    h.questionForKey.mockResolvedValue({ ...q, requestedModel: "gemini-3.8-flash-high" });
    expect((await (await get(ID)).json()).requestedModel).toBe("ag/gemini-3.8-flash-high");
  });
});

describe("POST /api/v1/ai/questions answered by the provider (owner 14 Oct)", () => {
  beforeEach(() => {
    h.loadAskContext.mockResolvedValue({ agConnected: false, agEnabled: [], providerReady: true });
  });
  it("Default: 201 with the answer, who answered and where to read it back; stored answered for the key", async () => {
    const r = await post('{"question":"  Anything expiring?  "}');
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toEqual({
      id: ID, status: "answered", answer: "Nothing expires this week.", answeredBy: { client: "watchpost", model: "test/prrojects" },
      askedAt: expect.stringMatching(/^\d{4}-/), answeredAt: expect.stringMatching(/^\d{4}-/), pollUrl: `${ORIGIN}/api/v1/ai/questions/${ID}`,
    });
    expect(r.headers.get("location")).toBe(body.pollUrl);
    expect(h.answerWithProvider).toHaveBeenCalledWith("Anything expiring?", { model: undefined, now: expect.any(Date) });
    expect(h.storeAnswered).toHaveBeenCalledWith(expect.objectContaining({ kind: "general", contextId: null, by: "key-1", question: "Anything expiring?", client: "watchpost", model: "test/prrojects" }));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.recordApiCall).toHaveBeenCalledWith(key, "status", "ai/questions", expect.any(Number), 201);
  });
  it("a provider model id is answered by that model (also while Antigravity is connected)", async () => {
    h.loadAskContext.mockResolvedValue({ agConnected: true, agEnabled: ["gemini-3.8-flash-high"], providerReady: true });
    const r = await post(JSON.stringify({ question: "Hi?", model: "test/prrojects" }));
    expect(r.status).toBe(201);
    expect(h.answerWithProvider).toHaveBeenCalledWith("Hi?", { model: "test/prrojects", now: expect.any(Date) });
  });
  it("a gateway error: its curated message and status, nothing stored or queued", async () => {
    h.answerWithProvider.mockRejectedValue(Object.assign(new Error('Model "x" isn\'t enabled.'), { name: "GatewayError", type: "model_not_enabled", status: 400 }));
    const r = await post(JSON.stringify({ question: "Hi?", model: "x" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { type: "model_not_enabled", message: 'Model "x" isn\'t enabled.' } });
    expect(h.storeAnswered).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("an unexpected failure hides its text; nothing stored", async () => {
    h.answerWithProvider.mockRejectedValue(new Error("sk-secret upstream body"));
    const r = await post('{"question":"Hi?"}');
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("sk-secret");
    expect(h.storeAnswered).not.toHaveBeenCalled();
  });
  it("no provider and no Antigravity: 503 provider_not_connected", async () => {
    h.loadAskContext.mockResolvedValue({ agConnected: false, agEnabled: [], providerReady: false });
    const r = await post('{"question":"Hi?"}');
    expect(r.status).toBe(503);
    expect((await r.json()).error.type).toBe("provider_not_connected");
  });
});
