import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthRow } from "@/private/keys/keys-db";
import { hashKey } from "@/private/keys/key";

const h = vi.hoisted(() => ({ authLookup: vi.fn() }));
vi.mock("@/private/keys/keys-db", () => ({ authLookup: h.authLookup }));

import { authenticateApiKey } from "./api-key";

const KEY = `wp_${"k".repeat(40)}`;
const req = (headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) => new Request("https://ops.example.com/api/v1/me", { headers });
const row = (over: Partial<AuthRow> = {}): AuthRow => ({
  id: "k1", name: "portfolio-advisor", prefix: "wp_kkkk", scopes: ["ai:invoke", "read:status"], ratePerMin: 20, providerId: null, model: null, hits: 1, ...over,
});
const body = async (r: Response) => (await r.json()) as { error: { type: string; message: string } };

beforeEach(() => {
  h.authLookup.mockReset();
  h.authLookup.mockResolvedValue(row());
});

describe("authenticateApiKey", () => {
  it("401 without a header, and the database is not asked", async () => {
    const r = await authenticateApiKey(req({}), "any");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect((await body(r.response)).error.type).toBe("invalid_api_key");
    expect(h.authLookup).not.toHaveBeenCalled();
  });

  it("401 for a malformed key or another scheme, without a lookup", async () => {
    for (const authorization of ["Bearer nope", `Basic ${KEY}`, `Bearer hb_${"k".repeat(40)}`, KEY]) {
      const r = await authenticateApiKey(req({ authorization }), "any");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(401);
    }
    expect(h.authLookup).not.toHaveBeenCalled();
  });

  it("401 for an unknown, revoked or expired key (the lookup finds nothing)", async () => {
    h.authLookup.mockResolvedValue(null);
    const r = await authenticateApiKey(req(), "read:status");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect((await body(r.response)).error.type).toBe("invalid_api_key");
    expect(r.response.headers.get("cache-control")).toBe("no-store");
  });

  it("looks the key up by its sha256, never by the key itself", async () => {
    await authenticateApiKey(req(), "any");
    expect(h.authLookup).toHaveBeenCalledTimes(1);
    expect(h.authLookup.mock.calls[0][0]).toBe(hashKey(KEY));
    expect(h.authLookup.mock.calls[0][1]).toBeInstanceOf(Date);
  });

  it("403 missing_scope when the key lacks the scope", async () => {
    const r = await authenticateApiKey(req(), "write:notes");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
    expect((await body(r.response)).error.type).toBe("missing_scope");
  });

  it("scope any needs only some scope", async () => {
    expect((await authenticateApiKey(req(), "any")).ok).toBe(true);
  });

  it("allows the 20th call in a minute and answers the 21st with 429 and Retry-After", async () => {
    h.authLookup.mockResolvedValue(row({ hits: 20 }));
    expect((await authenticateApiKey(req(), "read:status")).ok).toBe(true);
    h.authLookup.mockResolvedValue(row({ hits: 21 }));
    const r = await authenticateApiKey(req(), "read:status");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(429);
    expect((await body(r.response)).error.type).toBe("key_rate_limit");
    const retry = Number(r.response.headers.get("retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it("returns the key context with the detected client", async () => {
    const r = await authenticateApiKey(req({ authorization: `Bearer ${KEY}`, "x-client": "OpenClaw/2026.10.2", "user-agent": "node" }), "ai:invoke");
    expect(r).toEqual({
      ok: true,
      key: {
        keyId: "k1", name: "portfolio-advisor", prefix: "wp_kkkk", scopes: ["ai:invoke", "read:status"], ratePerMin: 20, providerId: null, model: null,
        client: { name: "openclaw", version: "2026.10.2", via: "x-client", userAgent: "node" },
      },
    });
  });

  it("answers 503 when the database fails, without echoing the error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.authLookup.mockRejectedValue(new Error(`select … where key_hash = ${hashKey(KEY)}`));
    const r = await authenticateApiKey(req(), "any");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    expect(JSON.stringify(await body(r.response))).not.toContain(hashKey(KEY));
    expect(JSON.stringify(spy.mock.calls)).not.toContain(hashKey(KEY));
    spy.mockRestore();
  });
});
