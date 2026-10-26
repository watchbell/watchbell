import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenConnection } from "@/private/ai/providers/adapter";

const h = vi.hoisted(() => ({
  resolveModel: vi.fn(), openConnections: vi.fn(), consoleDefaultModel: vi.fn(), recordCall: vi.fn(), consoleSnapshot: vi.fn(), readAgSettings: vi.fn(),
  pending: [] as Promise<unknown>[],
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => { h.pending.push(fn()); } }));
vi.mock("@/private/ai/providers/providers-db", () => ({ resolveModel: h.resolveModel, openConnections: h.openConnections, consoleDefaultModel: h.consoleDefaultModel }));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: h.readAgSettings }));
vi.mock("@/private/ai/usage", async (orig) => ({ ...(await orig<typeof import("@/private/ai/usage")>()), recordCall: h.recordCall }));
vi.mock("@/private/console/snapshot", () => ({ consoleSnapshot: h.consoleSnapshot }));

import { chooseAskPath, MODEL_UNAVAILABLE, NO_PROVIDER } from "./ask-path";
import { answerWithProvider, loadAskContext } from "./provider-answer";

const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => { server.resetHandlers(); });
afterAll(() => server.close());

const BASE = "https://router.example.test/v1";
const conn: OpenConnection = {
  id: "p-test", slug: "test", kind: "custom", name: "test", enabled: true, isDefault: true, baseUrl: BASE,
  secret: { apiKey: "sk-test-000000000000000000" }, limits: [], updatedAt: new Date(0),
  models: [{ id: "fast", upstream: "fast", enabled: true }],
} as OpenConnection;
const NOW = new Date("2026-10-14T01:00:00.000Z");
const snapshot = {
  generatedAt: NOW.toISOString(), monitors: { up: 3, degraded: 0, down: 1, paused: 0 }, alerts: { open: 1, critical: 1 },
  apps: [{ id: "portfolio-site", state: "down", uptime30d: 99.1, database: "db-a", lastDeploy: null, problems: [{ kind: "monitor", where: "/", what: "HTTP 502 at https://secret.example.com/x", fix: null }] }],
};
const settle = async () => { await Promise.all(h.pending.splice(0)); };
const seen: { body: Record<string, unknown> }[] = [];
const answerWith = (content: string) => server.use(http.post(`${BASE}/chat/completions`, async ({ request }) => {
  seen.push({ body: (await request.json()) as Record<string, unknown> });
  return HttpResponse.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
}));

beforeEach(() => {
  seen.length = 0;
  unmatched.length = 0;
  h.pending.length = 0;
  h.openConnections.mockReset().mockResolvedValue([conn]);
  h.consoleDefaultModel.mockReset().mockResolvedValue(null);
  h.resolveModel.mockReset().mockImplementation(async (id: string) => (id === "test/prrojects" ? { conn, upstream: "prrojects", publicId: "test/prrojects" } : "model_not_enabled"));
  h.recordCall.mockReset().mockResolvedValue(undefined);
  h.consoleSnapshot.mockReset().mockResolvedValue(structuredClone(snapshot));
  h.readAgSettings.mockReset().mockResolvedValue({ report: null, prefs: { disabled: [], defaultModel: null }, allowed: ["gemini"] });
});

describe("answerWithProvider", () => {
  it("sends the scrubbed console snapshot and the question to the default provider, records kind console", async () => {
    answerWith("  Portfolio is down: roll back.  ");
    const r = await answerWithProvider("What is down?", { now: NOW });
    await settle();
    expect(r).toEqual({ text: "Portfolio is down: roll back.", model: "test/fast", ms: expect.any(Number) });
    const msgs = seen[0].body.messages as { role: string; content: string }[];
    expect(seen[0].body.model).toBe("fast");
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("Console data (scrubbed");
    expect(msgs[1].content).toContain("portfolio-site");
    expect(msgs[1].content).toContain("Question: What is down?");
    expect(msgs[1].content).not.toContain("secret.example.com");
    expect(h.consoleSnapshot).toHaveBeenCalledWith(NOW);
    expect(h.recordCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "console", model: "test/fast", status: 200, tokensIn: 900, tokensOut: 40 }), expect.any(Array));
  });

  it("uses the chosen provider model (a manual router combo) and adds scrubbed context", async () => {
    answerWith("ok");
    const r = await answerWithProvider("Why?", { model: "test/prrojects", context: "App web-x, see https://a.example.com and owner@example.com", now: NOW });
    expect(r.model).toBe("test/prrojects");
    expect(seen[0].body.model).toBe("prrojects");
    const user = (seen[0].body.messages as { content: string }[])[1].content;
    expect(user).toContain("Context: App web-x");
    expect(user).not.toContain("a.example.com");
    expect(user).not.toContain("owner@example.com");
  });

  it("caps the answer at 8000 characters", async () => {
    answerWith("x".repeat(9000));
    expect((await answerWithProvider("q", { now: NOW })).text).toHaveLength(8000);
  });

  it("a provider failure throws the gateway's curated error (no upstream text) and records the failure", async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => HttpResponse.json({ error: { message: "key sk-live-abc leaked" } }, { status: 429 })));
    const e = await answerWithProvider("q", { now: NOW }).catch((x: unknown) => x);
    await settle();
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).name).toBe("GatewayError");
    expect((e as Error).message).not.toContain("sk-live");
    expect(h.recordCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "console", status: 429 }), expect.any(Array));
  });

  it("an unreachable provider (catch-all = network failure) is a GatewayError too", async () => {
    const e = await answerWithProvider("q", { now: NOW }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("GatewayError");
    unmatched.length = 0;
  });

  it("a model with fallback (the office's preference) moves to another enabled provider when its own is down (owner item #19)", async () => {
    const backup = { ...conn, id: "p-backup", slug: "backup", name: "Backup", isDefault: false, baseUrl: "https://backup.example.test/v1", models: [{ id: "b-1", upstream: "b-1", enabled: true }] } as OpenConnection;
    h.openConnections.mockResolvedValue([conn, backup]);
    let backupHits = 0;
    server.use(
      http.post(`${BASE}/chat/completions`, () => new HttpResponse(null, { status: 530 })),
      http.post("https://backup.example.test/v1/chat/completions", () => { backupHits++; return HttpResponse.json({ choices: [{ message: { content: "from backup" } }] }); }),
    );
    await expect(answerWithProvider("q", { model: "test/prrojects", fallback: true, now: NOW })).resolves.toMatchObject({ text: "from backup", model: "backup/b-1" });
    expect(backupHits).toBe(1);
    // the same model picked by name (Ask with a chosen model) stays on its provider and says so
    const e = (await answerWithProvider("q", { model: "test/prrojects", now: NOW }).catch((x: unknown) => x)) as Error;
    expect(e.name).toBe("GatewayError");
    expect(e.message).toBe('AI provider "test" is unreachable (its endpoint or tunnel is down). This model was picked by name, so no other provider was tried.');
    expect(backupHits).toBe(1);
    await settle();
  });

  it("an empty completion is an error, not an empty answer", async () => {
    answerWith("   ");
    await expect(answerWithProvider("q", { now: NOW })).rejects.toThrow("The model returned no text. Try again.");
  });
});

describe("chooseAskPath (owner 14 Oct: the provider first)", () => {
  const off = { agConnected: false, agEnabled: [] as string[], providerReady: true };
  const on = { agConnected: true, agEnabled: ["gemini-3.8-pro"], providerReady: true };
  it("Default goes to the provider whether or not Antigravity is connected", () => {
    expect(chooseAskPath("", off)).toEqual({ via: "provider" });
    expect(chooseAskPath(null, on)).toEqual({ via: "provider" });
  });
  it("Default without a provider: Antigravity when connected, else a clear error", () => {
    expect(chooseAskPath(undefined, { ...on, providerReady: false })).toEqual({ via: "antigravity", model: null });
    expect(chooseAskPath(undefined, { ...off, providerReady: false })).toEqual({ via: "none", error: NO_PROVIDER });
  });
  it("a provider model id goes to the provider", () => {
    expect(chooseAskPath("test/prrojects", on)).toEqual({ via: "provider", model: "test/prrojects" });
    expect(chooseAskPath("test/prrojects", off)).toEqual({ via: "provider", model: "test/prrojects" });
  });
  it("an ag/ model goes to the inbox only while Antigravity is connected and the model is on", () => {
    expect(chooseAskPath("ag/gemini-3.8-pro", on)).toEqual({ via: "antigravity", model: "gemini-3.8-pro" });
    expect(chooseAskPath("gemini-3.8-pro", on)).toEqual({ via: "antigravity", model: "gemini-3.8-pro" });
    expect(chooseAskPath("ag/gemini-3.8-pro", { ...on, agConnected: false })).toEqual({ via: "none", error: MODEL_UNAVAILABLE });
    expect(chooseAskPath("ag/claude-x", on)).toEqual({ via: "none", error: MODEL_UNAVAILABLE });
  });
  it("refuses an absurdly long model id", () => {
    expect(chooseAskPath("x".repeat(201), on).via).toBe("none");
  });
});

describe("loadAskContext", () => {
  const report = (reportedAt: string) => ({ models: [{ id: "gemini-3.8-pro", label: "Pro" }], limits: [], reportedAt, client: null });
  it("an old report, a failed read or no provider read as not connected / not ready", async () => {
    h.readAgSettings.mockResolvedValue({ report: report(new Date(NOW.getTime() - 25 * 3600_000).toISOString()), prefs: { disabled: [], defaultModel: null }, allowed: ["gemini"] });
    h.openConnections.mockResolvedValue([]);
    expect(await loadAskContext(NOW)).toEqual({ agConnected: false, agEnabled: [], providerReady: false });
    h.readAgSettings.mockRejectedValue(new Error("db"));
    expect((await loadAskContext(NOW)).agConnected).toBe(false);
  });
});
