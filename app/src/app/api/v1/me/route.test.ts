import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ authenticateApiKey: vi.fn(), keyExpiry: vi.fn(), recordApiCall: vi.fn() }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.authenticateApiKey }));
vi.mock("@/private/keys/keys-db", () => ({ keyExpiry: h.keyExpiry }));
vi.mock("@/private/ai/usage", () => ({ recordApiCall: h.recordApiCall }));

import { GET } from "./route";

const client = { name: "openclaw", version: "2026.10.2", via: "x-client" as const, userAgent: "node" };
const ctx = { keyId: "k1", name: "laptop-agents", prefix: "wp_Lm9x", scopes: ["ai:invoke", "read:status"], ratePerMin: 30, providerId: null, model: null, client };
const req = () => new Request("https://ops.example.com/api/v1/me", { headers: { authorization: `Bearer wp_${"a".repeat(40)}` } });

beforeEach(() => {
  h.authenticateApiKey.mockReset();
  h.keyExpiry.mockReset();
  h.recordApiCall.mockReset();
  h.authenticateApiKey.mockResolvedValue({ ok: true, key: ctx });
  h.keyExpiry.mockResolvedValue(new Date("2027-01-11T00:00:00Z"));
});

describe("GET /api/v1/me", () => {
  it("answers { name, prefix, scopes, rateLimitPerMin, expiresAt } and nothing else", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      name: "laptop-agents", prefix: "wp_Lm9x", scopes: ["ai:invoke", "read:status"], rateLimitPerMin: 30, expiresAt: "2027-01-11T00:00:00.000Z",
    });
  });

  it("expiresAt is null for a key that never expires", async () => {
    h.keyExpiry.mockResolvedValue(null);
    expect(((await (await GET(req())).json()) as { expiresAt: unknown }).expiresAt).toBeNull();
  });

  it("never shows the hash, an id or the client details", async () => {
    const text = JSON.stringify(await (await GET(req())).json());
    for (const word of ["hash", "keyId", "k1", "openclaw", "userAgent"]) expect(text).not.toContain(word);
  });

  it("accepts any scope", async () => {
    await GET(req());
    expect(h.authenticateApiKey).toHaveBeenCalledWith(expect.any(Request), "any");
  });

  it("passes the 401 / 403 / 429 from authentication through, and records nothing", async () => {
    const failure = Response.json({ error: { type: "invalid_api_key", message: "x" } }, { status: 401 });
    h.authenticateApiKey.mockResolvedValue({ ok: false, response: failure });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.keyExpiry).not.toHaveBeenCalled();
    expect(h.recordApiCall).not.toHaveBeenCalled();
  });

  it("records the call through the shared writer (kind me, the detected client; deferred to after() there)", async () => {
    await GET(req());
    expect(h.recordApiCall).toHaveBeenCalledTimes(1);
    expect(h.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({ keyId: "k1", client }), "me", null, expect.any(Number), 200);
  });
});
