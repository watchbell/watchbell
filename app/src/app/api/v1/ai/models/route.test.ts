import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), openConnections: vi.fn(), recordCall: vi.fn(), readAgSettings: vi.fn() }));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: h.readAgSettings }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => { void fn(); } }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/private/ai/providers/providers-db", () => ({ openConnections: h.openConnections, resolveModel: vi.fn() }));
vi.mock("@/private/ai/usage", async (orig) => ({ ...(await orig<typeof import("@/private/ai/usage")>()), recordCall: h.recordCall }));

import { GET } from "./route";
import { POST } from "../chat/completions/route";

const key = { keyId: "k1", name: "n", prefix: "wp_1234", scopes: ["ai:invoke"], ratePerMin: 20, providerId: null as string | null, model: null as string | null, client: { name: "curl", version: "8", via: "user-agent", userAgent: "curl/8" } };
const conns = [
  { id: "p1", slug: "gemini", enabled: true, isDefault: true, models: [{ id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true }, { id: "gemini-2.5-pro", upstream: "gemini-2.5-pro", enabled: false }] },
  { id: "p2", slug: "cloudflare", enabled: true, isDefault: false, models: [{ id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it", enabled: true }] },
  { id: "p3", slug: "my-llm", enabled: false, isDefault: false, models: [{ id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true }] },
];
const get = () => GET(new Request("https://watchbell.test/api/v1/ai/models", { headers: { authorization: "Bearer wp_x" } }));

beforeEach(() => {
  h.auth.mockReset().mockResolvedValue({ ok: true, key });
  h.openConnections.mockReset().mockResolvedValue(conns);
  h.recordCall.mockReset().mockResolvedValue(undefined);
  h.readAgSettings.mockReset().mockResolvedValue({ report: null, prefs: { disabled: [], defaultModel: null }, allowed: ["gemini", "claude"] });
});

describe("GET /api/v1/ai/models", () => {
  it("lists enabled models of enabled connections as provider/model, owned by watchbell", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ object: "list", data: [
      { id: "gemini/gemini-3.8-flash", object: "model", created: 0, owned_by: "watchbell" },
      { id: "cloudflare/gemma-3-12b-it", object: "model", created: 0, owned_by: "watchbell" },
    ] });
    expect(h.recordCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "models", keyId: "k1", status: 200 }), []);
  });
  it("a key pinned to a provider or model sees only that", async () => {
    h.auth.mockResolvedValue({ ok: true, key: { ...key, providerId: "p2" } });
    expect((await (await get()).json()).data.map((m: { id: string }) => m.id)).toEqual(["cloudflare/gemma-3-12b-it"]);
    h.auth.mockResolvedValue({ ok: true, key: { ...key, model: "gemini/gemini-3.8-flash" } });
    expect((await (await get()).json()).data.map((m: { id: string }) => m.id)).toEqual(["gemini/gemini-3.8-flash"]);
  });
  it("needs ai:invoke; failures answer before reading connections", async () => {
    h.auth.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "missing_scope", message: "x" } }, { status: 403 }) });
    expect((await get()).status).toBe(403);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "ai:invoke");
    expect(h.openConnections).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/ai/chat/completions", () => {
  it("is the gateway (key check first)", async () => {
    h.auth.mockResolvedValue({ ok: false, response: Response.json({ error: { type: "invalid_api_key", message: "x" } }, { status: 401 }) });
    const res = await POST(new Request("https://watchbell.test/api/v1/ai/chat/completions", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "ai:invoke");
  });
});
