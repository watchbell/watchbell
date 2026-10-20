import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/private/api/respond";

const h = vi.hoisted(() => ({ auth: vi.fn(), adviceFor: vi.fn(), recordApiCall: vi.fn() }));
vi.mock("@/private/ai/usage", () => ({ recordApiCall: h.recordApiCall }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/private/console/advice", () => ({ adviceFor: h.adviceFor }));

import { GET } from "./route";

const key = { keyId: "k1", name: "portfolio", prefix: "wp_abcd", scopes: ["read:status"], ratePerMin: 20, providerId: null, model: null, client: { name: "x", version: "", via: "unknown", userAgent: "" } };
const call = (qs: string) => GET(new Request(`https://watch.example.com/api/v1/advice${qs}`, { headers: { authorization: "Bearer wp_x" } }));

beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ ok: true, key });
});

describe("GET /api/v1/advice", () => {
  it("needs read:status: 401/403 pass through and nothing is read", async () => {
    for (const [type, status] of [["invalid_api_key", 401], ["missing_scope", 403]] as const) {
      h.auth.mockResolvedValue({ ok: false, response: apiError(type, "no", status) });
      expect((await call("?app=orbit-blog")).status).toBe(status);
    }
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "read:status");
    expect(h.adviceFor).not.toHaveBeenCalled();
  });

  it("answers the app's notes, never cached", async () => {
    h.adviceFor.mockResolvedValue({ app: "orbit-blog", notes: [{ id: "n1", severity: "warn", title: "t", body: "b", source: "antigravity", model: "gemini-3.8-flash", createdAt: "2026-10-13T00:00:00.000Z" }] });
    const r = await call("?app=Orbit-Blog");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(h.adviceFor).toHaveBeenCalledWith("Orbit-Blog", expect.any(Date));
    expect((await r.json()).notes).toHaveLength(1);
  });

  it("answers an empty list for an app without notes", async () => {
    h.adviceFor.mockResolvedValue({ app: "acme-shop", notes: [] });
    expect(await (await call("?app=acme-shop")).json()).toEqual({ app: "acme-shop", notes: [] });
  });

  it("answers 404 not_found for an unknown app", async () => {
    h.adviceFor.mockResolvedValue(null);
    const r = await call("?app=nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("not_found");
  });

  it("answers 400 when app is missing, blank or too long", async () => {
    for (const qs of ["", "?app=", "?app=%20%20", `?app=${"x".repeat(101)}`]) {
      const r = await call(qs);
      expect(r.status, qs).toBe(400);
      expect((await r.json()).error.type).toBe("invalid_request");
    }
    expect(h.adviceFor).not.toHaveBeenCalled();
  });

  it("answers 502 when the console can't be read, without the failure's text", async () => {
    h.adviceFor.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await call("?app=orbit-blog");
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("ECONNREFUSED");
    warn.mockRestore();
  });
});

describe("usage recording (stage 5c: Agents shows the portfolio's advice calls)", () => {
  it("records each authenticated call through the shared writer with its status; a failed auth records nothing", async () => {
    h.adviceFor.mockResolvedValue({ app: "orbit-blog", notes: [] });
    await call("?app=orbit-blog");
    expect(h.recordApiCall).toHaveBeenCalledWith(key, "status", "advice", expect.any(Number), 200);
    await call("");
    expect(h.recordApiCall).toHaveBeenLastCalledWith(key, "status", "advice", expect.any(Number), 400);
    h.recordApiCall.mockClear();
    h.auth.mockResolvedValue({ ok: false, response: apiError("missing_scope", "no", 403) });
    await call("?app=orbit-blog");
    expect(h.recordApiCall).not.toHaveBeenCalled();
  });
});
