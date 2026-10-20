import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";
import { seal } from "@/lib/crypto";

const ENC = Buffer.alloc(32, 7).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, models: vi.fn(), testGenerate: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }) }));
vi.mock("./adapter", async (orig) => ({ ...(await orig<typeof import("./adapter")>()), models: h.models, testGenerate: h.testGenerate }));

import { connect, consoleDefaultModel, dropConnectionCache, listConnections, openConnections, resolveModel, setModelEnabled, testConnection } from "./providers-db";

const KEY = "AQ.Fake0TstKplaintext-secret-000000000";
const listed = [{ id: "gemini-2.5-pro", upstream: "gemini-2.5-pro" }, { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash" }];

beforeEach(() => {
  dropConnectionCache();
  h.models.mockReset().mockResolvedValue(listed);
  h.testGenerate.mockReset().mockResolvedValue({ ok: true, ms: 120 });
});

describe("connect", () => {
  it("lists models and tests a tiny generation before saving; the row holds no plaintext key", async () => {
    h.current = fakeDb([[]], [[], [{ id: "p-new" }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    const r = await connect("gemini", { apiKey: KEY });
    expect(r).toMatchObject({ ok: true, data: { id: "p-new" } });
    expect(h.testGenerate).toHaveBeenCalledWith(expect.objectContaining({ kind: "gemini" }), "gemini-3.8-flash", expect.any(Number), 16);
    const insert = f.writes.find((w) => w.kind === "insert")!;
    const row = payloadOf(insert.calls)!;
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain("plaintext-secret");
    expect(row).toMatchObject({ kind: "gemini", keyHint: "AQ.…000", isDefault: true, enabled: true, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
    expect(row.models).toEqual([{ id: "gemini-2.5-pro", upstream: "gemini-2.5-pro", enabled: false }, { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true }]);
  });
  it("Google's denied project: not saved, the owner's message", async () => {
    h.testGenerate.mockResolvedValue({ ok: false, status: 403, errorClass: "project_denied", error: "Google denied this project's Gemini API access. Use a key from another Google project or account." });
    h.current = fakeDb([[]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    expect(await connect("gemini", { apiKey: KEY })).toEqual({ ok: false, error: "Google denied this project's Gemini API access. Use a key from another Google project or account." });
    expect(f.writes).toEqual([]);
  });
  it("refuses dropped presets, a second Gemini, and bad keys without calling Google", async () => {
    h.current = fakeDb([[{ id: "p1", kind: "gemini", name: "Google Gemini", isDefault: true }]]);
    expect(await connect("groq", { apiKey: "gsk_123456789" })).toEqual({ ok: false, error: "That provider isn't offered." });
    expect(await connect("gemini", { apiKey: KEY })).toEqual({ ok: false, error: "Google Gemini is already connected. Replace its key instead." });
    expect((await connect("gemini", { apiKey: "nope" })).ok).toBe(false);
    expect(h.models).not.toHaveBeenCalled();
  });
});

describe("reads", () => {
  it("listConnections never selects the sealed secret", async () => {
    h.current = fakeDb([[{ id: "p1", kind: "gemini", name: "Google Gemini", baseUrl: "b", keyHint: "AQ.…000", enabled: true, isDefault: true, models: [], limits: [], lastTestAt: null, lastTestStatus: null, lastError: null, createdAt: new Date(0) }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    const [c] = await listConnections();
    expect(c.slug).toBe("gemini");
    const selected = Object.keys(f.queries[0].find((q) => q.method === "select")!.args[0] as object);
    expect(selected).not.toContain("ciphertext");
    expect(selected).not.toContain("iv");
  });
  it("opens secrets once per minute and routes through them", async () => {
    const sealed = seal(JSON.stringify({ apiKey: KEY }), ENC);
    const row = { id: "p1", kind: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", ...sealed, enabled: true, isDefault: true,
      models: [{ id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true }], limits: [], updatedAt: new Date(0) };
    h.current = fakeDb([[row, { ...row, id: "p-old", kind: "groq" }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    const r = await resolveModel("gemini-3.8-flash", null);
    expect(r).toMatchObject({ upstream: "gemini-3.8-flash", publicId: "gemini/gemini-3.8-flash", conn: { secret: { apiKey: KEY } } });
    expect(await resolveModel("gemini-2.5-pro", null)).toBe("model_not_enabled");
    expect((await openConnections()).map((c) => c.id)).toEqual(["p1"]); // the dropped Groq preset is left out
    expect(f.queries.length).toBe(1);
  });
  it("consoleDefaultModel reads ops.settings ai.defaultModel; blank, non-string or a failed read is null", async () => {
    h.current = fakeDb([[{ value: " gemini/gemini-2.5-pro " }]]);
    expect(await consoleDefaultModel()).toBe("gemini/gemini-2.5-pro");
    h.current = fakeDb([[{ value: ["x"] }]]);
    expect(await consoleDefaultModel()).toBeNull();
    h.current = fakeDb([[]]);
    expect(await consoleDefaultModel()).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.current = { db: () => { throw new Error("down"); } };
    expect(await consoleDefaultModel()).toBeNull();
    warn.mockRestore();
  });
});

describe("test and models", () => {
  it("a failing test is stored as status + message (never the upstream body)", async () => {
    const sealed = seal(JSON.stringify({ apiKey: KEY }), ENC);
    h.testGenerate.mockResolvedValue({ ok: false, status: 403, errorClass: "project_denied", error: "Google denied this project's Gemini API access. Use a key from another Google project or account." });
    h.current = fakeDb([[{ id: "p1", kind: "gemini", name: "Google Gemini", baseUrl: "b", ...sealed, enabled: true, isDefault: true, models: [], limits: [], updatedAt: new Date(0) }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    expect((await testConnection("p1")).ok).toBe(false);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ lastTestStatus: 403, lastError: expect.stringContaining("denied") });
  });
  it("Test reads the stored secret again instead of the 60 s cache (a key replaced on another instance)", async () => {
    const row = (apiKey: string) => ({ id: "p1", kind: "gemini", name: "Google Gemini", baseUrl: "b", ...seal(JSON.stringify({ apiKey }), ENC), enabled: true, isDefault: true, models: [], limits: [], updatedAt: new Date(0) });
    h.current = fakeDb([[row("AQ.old-key-000000000000")]]);
    await openConnections(); // warms this instance's cache with the old key
    h.current = fakeDb([[row("AQ.new-key-000000000000")]]);
    await testConnection("p1");
    expect(h.models).toHaveBeenCalledWith(expect.objectContaining({ secret: { apiKey: "AQ.new-key-000000000000" } }));
  });
  it("a preset (Gemini) offers only Google models", async () => {
    const view = { id: "p1", kind: "gemini", name: "Gemini", baseUrl: "b", keyHint: "…zzz", enabled: true, isDefault: true, limits: [], lastTestAt: null, lastTestStatus: null, lastError: null, createdAt: new Date(0),
      models: [{ id: "llama-3.3-70b", upstream: "llama-3.3-70b", enabled: false }, { id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: false }] };
    h.current = fakeDb([[view], [view]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    expect(await setModelEnabled("p1", "llama-3.3-70b", true)).toEqual({ ok: false, error: PROVIDERS_COPY.onlyGoogleOffered });
    expect(await setModelEnabled("p1", "gemini-2.5-flash", true)).toEqual({ ok: true, message: "gemini/gemini-2.5-flash: on." });
    expect(payloadOf(f.writes[0].calls)!.models).toEqual([{ id: "llama-3.3-70b", upstream: "llama-3.3-70b", enabled: false }, { id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true }]);
  });
  it("a custom server (owner 14 Oct): any listed model can be switched on", async () => {
    const view = { id: "p1", kind: "custom", name: "my-llm", baseUrl: "b", keyHint: "…zzz", enabled: true, isDefault: true, limits: [], lastTestAt: null, lastTestStatus: null, lastError: null, createdAt: new Date(0),
      models: [{ id: "llama-3.3-70b", upstream: "llama-3.3-70b", enabled: false }] };
    h.current = fakeDb([[view], [view]]);
    expect(await setModelEnabled("p1", "llama-3.3-70b", true)).toEqual({ ok: true, message: "my-llm/llama-3.3-70b: on." });
  });
  it("Cloudflare: account id + token, the newest Gemma instruct model is tested and turned on", async () => {
    h.models.mockResolvedValue([
      { id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it" },
      { id: "gemma-4-27b-it", upstream: "@cf/google/gemma-4-27b-it" },
      { id: "gemma-4-4b-it", upstream: "@cf/google/gemma-4-4b-it" },
    ]);
    h.current = fakeDb([[]], [[], [{ id: "p-cf" }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    const token = "cf_token_000000000000000000000000000000";
    const r = await connect("cloudflare", { accountId: "0123456789abcdef0123456789abcdef", apiKey: token });
    expect(r.ok).toBe(true);
    expect(h.testGenerate).toHaveBeenCalledWith(expect.objectContaining({ kind: "cloudflare", secret: { apiKey: token, accountId: "0123456789abcdef0123456789abcdef" } }), "@cf/google/gemma-4-27b-it", expect.any(Number), 16);
    const row = payloadOf(f.writes.find((w) => w.kind === "insert")!.calls)!;
    expect(row.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1");
    expect(JSON.stringify(row)).not.toContain(token);
    expect((row.models as { id: string; enabled: boolean }[]).filter((m) => m.enabled).map((m) => m.id)).toEqual(["gemma-4-27b-it"]);
  });
});
