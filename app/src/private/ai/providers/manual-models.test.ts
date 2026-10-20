import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";
import { seal } from "@/lib/crypto";

// Manual model ids on custom connections: the store layer with the real adapter; every provider call goes through MSW.
const ENC = Buffer.alloc(32, 7).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }) }));

import { addManualModel, dropConnectionCache, hasManualModel, removeManualModel, setModelEnabled, testConnection } from "./providers-db";

const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => { const leaked = unmatched.splice(0); server.resetHandlers(); expect(leaked).toEqual([]); });
afterAll(() => server.close());

const BASE = "https://llm.example.com/v1";
const KEY = "sk-test-plaintext-secret-000";
const listed = [{ id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true }];
type M = { id: string; upstream: string; enabled: boolean; manual?: boolean };
const openRow = (models: M[] = listed, over: Record<string, unknown> = {}) => ({
  id: "p-test", kind: "custom", name: "test", baseUrl: BASE, ...seal(JSON.stringify({ apiKey: KEY, baseUrl: BASE }), ENC), keyHint: "…000",
  enabled: true, isDefault: true, models, limits: [], lastTestAt: null, lastTestStatus: null, lastError: null, createdAt: new Date(0), updatedAt: new Date(0), ...over,
});
const db = (...reads: unknown[][]) => { h.current = fakeDb(reads); return h.current as ReturnType<typeof fakeDb>; };

// The tiny chat completion: answers 200 for `ok` models and records what was asked.
const asked: { model: unknown; auth: string | null; max: unknown }[] = [];
function chatServer(ok: string[], refuse: { status: number; body: Record<string, unknown> } = { status: 404, body: { error: { message: "model prrojects-x not found; key sk-test-plaintext-secret-000" } } }) {
  server.use(http.post(`${BASE}/chat/completions`, async ({ request }) => {
    const body = (await request.json()) as { model?: string; max_tokens?: number };
    asked.push({ model: body.model, auth: request.headers.get("authorization"), max: body.max_tokens });
    return ok.includes(String(body.model)) ? HttpResponse.json({ choices: [{ message: { content: "OK" } }] }) : HttpResponse.json(refuse.body, { status: refuse.status });
  }));
}

beforeEach(() => {
  dropConnectionCache();
  asked.splice(0);
});

describe("addManualModel", () => {
  it("tests one tiny completion with the id, then stores it as a manual, enabled model next to the listed ones", async () => {
    chatServer(["prrojects"]);
    const f = db([openRow()]);
    const r = await addManualModel("p-test", "prrojects");
    expect(r).toEqual({ ok: true, message: "test answered with prrojects. It is on as test/prrojects.", data: { name: "test" } });
    expect(asked).toEqual([{ model: "prrojects", auth: `Bearer ${KEY}`, max: 512 }]); // room for a combo whose first model thinks
    expect(f.writes).toHaveLength(1);
    expect(payloadOf(f.writes[0].calls)!.models).toEqual([...listed, { id: "prrojects", upstream: "prrojects", enabled: true, manual: true }]);
  });
  it("ids with slashes, colons and @ are allowed", async () => {
    chatServer(["ag/gemini-x", "combo:v2@eu"]);
    db([openRow()]);
    expect((await addManualModel("p-test", "ag/gemini-x")).ok).toBe(true);
    dropConnectionCache();
    db([openRow()]);
    expect((await addManualModel("p-test", "combo:v2@eu")).ok).toBe(true);
  });
  it("a refused model is not saved; the error is the provider's short message, never its body or the key", async () => {
    chatServer([]);
    const f = db([openRow()]);
    const r = await addManualModel("p-test", "prrojects-x");
    expect(r).toEqual({ ok: false, error: "The server refused that model: test doesn't know this model (404)." });
    expect(JSON.stringify(r)).not.toContain("plaintext-secret");
    expect(JSON.stringify(r)).not.toContain("not found;");
    expect(f.writes).toEqual([]);
  });
  it("an unreachable server is a refusal too", async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => HttpResponse.error()));
    const f = db([openRow()]);
    expect(await addManualModel("p-test", "prrojects")).toEqual({ ok: false, error: "The server refused that model: Can't reach test." });
    expect(f.writes).toEqual([]);
  });
  it("custom connections only; bad, duplicate or listed ids are refused before any call", async () => {
    db([openRow(listed, { kind: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" })]);
    expect(await addManualModel("p-test", "prrojects")).toEqual({ ok: false, error: "Model ids can be added on custom connections only." });
    for (const bad of ["", " ", "has space", "x".repeat(121), "semi;colon", "ünï"]) {
      dropConnectionCache();
      db([openRow()]);
      expect(await addManualModel("p-test", bad), bad).toEqual({ ok: false, error: "Use 1–120 letters, digits or . _ : / @ - for the model id." });
    }
    dropConnectionCache();
    db([openRow([...listed, { id: "prrojects", upstream: "prrojects", enabled: true, manual: true }])]);
    expect(await addManualModel("p-test", "prrojects")).toEqual({ ok: false, error: "test already has prrojects." });
    dropConnectionCache();
    db([openRow()]);
    expect(await addManualModel("p-test", "gemini-2.5-flash")).toEqual({ ok: false, error: "test already has gemini-2.5-flash." });
    expect(asked).toEqual([]);
  });
  it("a missing connection", async () => {
    db([], []);
    expect(await addManualModel("p-gone", "prrojects")).toEqual({ ok: false, error: "That connection no longer exists." });
  });
  it("at most 20 manual ids per connection", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, upstream: `m${i}`, enabled: true, manual: true }));
    db([openRow(many)]);
    expect(await addManualModel("p-test", "prrojects")).toEqual({ ok: false, error: "At most 20 added model ids per connection. Remove one first." });
  });
});

describe("removeManualModel", () => {
  it("removes an added id; listed models can't be removed", async () => {
    const models = [...listed, { id: "prrojects", upstream: "prrojects", enabled: true, manual: true }];
    let f = db([openRow(models)]);
    expect(await removeManualModel("p-test", "prrojects")).toEqual({ ok: true, message: "test/prrojects removed.", data: { name: "test" } });
    expect(payloadOf(f.writes[0].calls)!.models).toEqual(listed);
    f = db([openRow(models)]);
    expect(await removeManualModel("p-test", "gemini-2.5-flash")).toEqual({ ok: false, error: "Only model ids you added can be removed." });
    expect(f.writes).toEqual([]);
    db([]);
    expect(await removeManualModel("p-gone", "prrojects")).toEqual({ ok: false, error: "That connection no longer exists." });
  });
});

describe("manual models and the rest of the store", () => {
  it("a /models refresh keeps manual entries (and their on/off state); a new listed model waits off for the sync's test (owner 16 Oct)", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "gemini-2.5-flash" }, { id: "gemini-3.8-flash" }, { id: "llama-3.3" }] })));
    chatServer(["gemini-3.8-flash"]);
    const manual = [{ id: "prrojects", upstream: "prrojects", enabled: true, manual: true }, { id: "ag/x", upstream: "ag/x", enabled: false, manual: true }];
    const f = db([openRow([...listed, ...manual])]);
    expect((await testConnection("p-test")).ok).toBe(true);
    expect(payloadOf(f.writes[0].calls)!.models).toEqual([
      { id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true },
      { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: false, pending: true, addedAt: expect.any(String) },
      { id: "llama-3.3", upstream: "llama-3.3", enabled: false, pending: true, addedAt: expect.any(String) },
      ...manual,
    ]);
  });
  it("a server that lists no model but has a manual one tests with that one", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.json({ data: [] })));
    chatServer(["prrojects"]);
    const manual = [{ id: "prrojects", upstream: "prrojects", enabled: true, manual: true }];
    const f = db([openRow(manual)]);
    expect((await testConnection("p-test")).ok).toBe(true);
    expect(asked.map((a) => a.model)).toEqual(["prrojects"]);
    expect(payloadOf(f.writes[0].calls)!.models).toEqual(manual);
  });
  it("a model the router no longer lists can't be switched on; switching on clears manualOff (model sync, owner 16 Oct)", async () => {
    const models = [{ id: "gone", upstream: "gone", enabled: false, removed: true }, { id: "x", upstream: "x", enabled: false, manualOff: true }];
    let f = db([openRow(models)]);
    expect((await setModelEnabled("p-test", "gone", true)).ok).toBe(false);
    expect(f.writes).toEqual([]);
    f = db([openRow(models)], [openRow(models)]);
    expect((await setModelEnabled("p-test", "x", true)).ok).toBe(true);
    expect(payloadOf(f.writes[0].calls)!.models).toEqual([models[0], { id: "x", upstream: "x", enabled: true }]);
  });
  it("on a custom server any model can be switched off and on, manual or listed (owner 14 Oct)", async () => {
    const models = [{ id: "prrojects", upstream: "prrojects", enabled: true, manual: true }, { id: "llama-3.3", upstream: "llama-3.3", enabled: false }];
    const f = db([openRow(models)], [openRow(models)]);
    expect(await setModelEnabled("p-test", "prrojects", false)).toEqual({ ok: true, message: "test/prrojects: off." });
    expect(payloadOf(f.writes[0].calls)!.models).toEqual([{ ...models[0], enabled: false, manualOff: true }, models[1]]);
    expect((await setModelEnabled("p-test", "llama-3.3", true)).ok).toBe(true);
  });
});

describe("hasManualModel (key routing pins)", () => {
  it("accepts the bare id and slug/id of a model on this custom connection, listed or added", async () => {
    const models = [...listed, { id: "prrojects", upstream: "prrojects", enabled: true, manual: true }];
    for (const [model, want] of [["prrojects", true], ["test/prrojects", true], ["gemini-2.5-flash", true], ["test/gemini-2.5-flash", true], ["llama-9", false], ["other/prrojects", false]] as const) {
      db([openRow(models)]);
      expect(await hasManualModel("p-test", model), model).toBe(want);
    }
    db([]);
    expect(await hasManualModel("p-gone", "prrojects")).toBe(false);
  });
});
