import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenConnection } from "./adapter";

const h = vi.hoisted(() => ({ openConnections: vi.fn(), dropConnectionCache: vi.fn(), recordCall: vi.fn(), set: vi.fn() }));
vi.mock("./providers-db", () => ({ openConnections: h.openConnections, dropConnectionCache: h.dropConnectionCache }));
vi.mock("@/private/ai/usage", async (orig) => ({ ...(await orig<typeof import("@/private/ai/usage")>()), recordCall: h.recordCall }));
vi.mock("@/db/client", () => ({ db: () => ({ update: () => ({ set: (v: unknown) => { h.set(v); return { where: async () => undefined }; } }) }) }));

import { runPool, scanOrder, shortTestError, testModels } from "./model-test";

const server = setupServer(http.all("*", () => HttpResponse.error()));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://router.example.test/v1";
const conn = (models: OpenConnection["models"]): OpenConnection => ({
  id: "p1", slug: "test", kind: "custom", name: "test", enabled: true, isDefault: true, baseUrl: BASE, secret: { apiKey: "sk-test-0000000000" },
  limits: [], updatedAt: new Date(0), models,
}) as OpenConnection;
const M = (id: string, o: object = {}) => ({ id, upstream: id, enabled: true, ...o });

beforeEach(() => {
  h.openConnections.mockReset();
  h.recordCall.mockReset().mockResolvedValue(undefined);
  h.set.mockReset();
  h.dropConnectionCache.mockReset();
});

describe("shortTestError", () => {
  it.each([
    [404, "not_found", "model not found (404)"], [403, "refused", "refused (403)"], [401, "auth_rejected", "key rejected (401)"],
    [429, "rate_limited", "rate limited (429)"], [400, "bad_request", "bad request (400)"], [0, "timeout", "timed out"], [0, "network", "unreachable"],
    [503, "upstream_error", "server error (503)"], [418, "x", "failed (418)"],
  ])("%i/%s → %s", (status, cls, text) => {
    expect(shortTestError(status, cls)).toBe(text);
  });
});

describe("runPool", () => {
  it("never runs more than the limit at once and keeps the order", async () => {
    let running = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, Date.now() + 60_000, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
  it("starts nothing once less than 5 s is left; the rest is undefined", async () => {
    let t = 0;
    const out = await runPool([1, 2, 3], 1, 10_000, async (n) => { t += 4_000; return n; }, () => t);
    expect(out).toEqual([1, 2, undefined]);
  });
});

describe("scanOrder", () => {
  it("never-tested first, then the oldest result", () => {
    const at = (iso: string) => ({ lastTest: { ok: true, ms: 1, at: iso } });
    expect(scanOrder([M("new"), M("b", at("2026-10-14T01:00:00Z")), M("a", at("2026-10-14T00:00:00Z")), M("new2")]).map((m) => m.id)).toEqual(["new", "new2", "a", "b"]);
  });
});

describe("testModels", () => {
  it("tests each model with one tiny completion, stores lastTest (short errors only) and records usage kind models", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(http.post(`${BASE}/chat/completions`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      bodies.push(b);
      if (b.model === "good") return HttpResponse.json({ choices: [{ message: { content: "OK" } }] });
      return HttpResponse.json({ error: { message: "no such model, key sk-live-123" } }, { status: 404 });
    }));
    const models = [M("good"), M("gone", { enabled: false }), M("combo", { manual: true })];
    h.openConnections.mockResolvedValue([conn(models)]);
    const r = await testModels("p1", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tested).toHaveLength(3);
    expect(r.skipped).toBe(0);
    expect(bodies.every((b) => b.max_tokens === 512)).toBe(true);
    const stored = (h.set.mock.calls[0][0] as { models: { id: string; enabled: boolean; lastTest?: { ok: boolean; error?: string } }[] }).models;
    expect(stored.find((m) => m.id === "good")?.lastTest).toMatchObject({ ok: true });
    expect(stored.find((m) => m.id === "gone")).toMatchObject({ enabled: false, lastTest: { ok: false, status: 404, error: "model not found (404)" } });
    expect(JSON.stringify(stored)).not.toContain("sk-live");
    expect(h.recordCall).toHaveBeenCalledTimes(3);
    expect(h.recordCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "models", providerId: "p1", model: "test/good", status: 200 }), []);
    expect(h.recordCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "models", model: "test/gone", status: 404 }), []);
    expect(h.dropConnectionCache).toHaveBeenCalled();
  });
  it("one model only; an unreachable server (catch-all) is stored as unreachable", async () => {
    h.openConnections.mockResolvedValue([conn([M("a"), M("b")])]);
    const r = await testModels("p1", ["b"]);
    expect(r).toMatchObject({ ok: true, tested: [{ id: "b", test: { ok: false, error: "unreachable" } }] });
    const stored = (h.set.mock.calls[0][0] as { models: { id: string; lastTest?: unknown }[] }).models;
    expect(stored.find((m) => m.id === "a")?.lastTest).toBeUndefined();
  });
  it("an unknown connection or model: an error, no call, nothing stored", async () => {
    h.openConnections.mockResolvedValue([conn([M("a")])]);
    expect((await testModels("p-gone", null)).ok).toBe(false);
    expect((await testModels("p1", ["zzz"])).ok).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.recordCall).not.toHaveBeenCalled();
  });
});
