import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/private/api/respond";

const h = vi.hoisted(() => ({ auth: vi.fn(), snapshot: vi.fn(), appDetail: vi.fn(), recordApiCall: vi.fn() }));
vi.mock("@/private/ai/usage", () => ({ recordApiCall: h.recordApiCall }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/private/console/snapshot", () => ({ consoleSnapshot: h.snapshot, appDetail: h.appDetail }));

import { GET } from "./route";
import { GET as GET_APP } from "./apps/[app]/route";

const key = { keyId: "k1", name: "laptop", prefix: "wp_abcd", scopes: ["read:status"], ratePerMin: 20, providerId: null, model: null, client: { name: "x", version: "", via: "unknown", userAgent: "" } };
const snap = {
  generatedAt: "2026-10-13T00:00:00.000Z", apps: [{ id: "orbit-blog", state: "down", uptime30d: 98, database: null, lastDeploy: null, problems: [] }],
  monitors: { up: 1, degraded: 0, down: 0, paused: 0 }, alerts: { open: 0, critical: 0, items: [] }, advisor: [],
};
const req = (qs = "") => new Request(`https://watch.example.com/api/v1/status${qs}`, { headers: { authorization: "Bearer wp_x" } });

beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ ok: true, key });
  h.snapshot.mockResolvedValue(snap);
});

describe("GET /api/v1/status", () => {
  it("asks for read:status and passes a failed authentication through (401, 403, 429) without reading the console", async () => {
    for (const [type, status] of [["invalid_api_key", 401], ["missing_scope", 403], ["key_rate_limit", 429]] as const) {
      h.auth.mockResolvedValue({ ok: false, response: apiError(type, "no", status, status === 429 ? { "Retry-After": "7" } : undefined) });
      const r = await GET(req());
      expect(r.status).toBe(status);
      expect((await r.json()).error.type).toBe(type);
    }
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "read:status");
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it("answers 200 with every section, never cached", async () => {
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(Object.keys(body)).toEqual(["generatedAt", "apps", "monitors", "alerts", "advisor"]);
    expect(h.snapshot).toHaveBeenCalledWith(expect.any(Date), ["apps", "monitors", "alerts", "advisor"]);
  });

  it("returns only the sections in include", async () => {
    const r = await GET(req("?include=alerts,apps"));
    expect(Object.keys(await r.json())).toEqual(["generatedAt", "apps", "alerts"]);
    expect(h.snapshot).toHaveBeenCalledWith(expect.any(Date), ["apps", "alerts"]);
  });

  it("rejects an unknown section with 400 and reads nothing", async () => {
    const r = await GET(req("?include=apps,passwords"));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ type: "invalid_request" });
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it("says 502 without a message from the failure when the console can't be read", async () => {
    h.snapshot.mockRejectedValue(new Error("password authentication failed for user postgres"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await GET(req());
    expect(r.status).toBe(502);
    const text = JSON.stringify(await r.json());
    expect(text).not.toContain("postgres");
    expect(warn).toHaveBeenCalledWith("status failed:", "Error");
    warn.mockRestore();
  });
});

describe("GET /api/v1/status/apps/{app}", () => {
  const call = (app: string) => GET_APP(new Request(`https://watch.example.com/api/v1/status/apps/${encodeURIComponent(app)}`), { params: Promise.resolve({ app }) });

  it("authenticates first (401) and answers the app detail", async () => {
    h.auth.mockResolvedValue({ ok: false, response: apiError("invalid_api_key", "no", 401) });
    expect((await call("orbit-blog")).status).toBe(401);
    expect(h.appDetail).not.toHaveBeenCalled();
    h.auth.mockResolvedValue({ ok: true, key });
    h.appDetail.mockResolvedValue({ ...snap.apps[0], monitors: [] });
    const r = await call("orbit-blog");
    expect(r.status).toBe(200);
    expect(h.appDetail).toHaveBeenCalledWith("orbit-blog", expect.any(Date));
    expect((await r.json()).id).toBe("orbit-blog");
    expect(h.auth).toHaveBeenLastCalledWith(expect.any(Request), "read:status");
  });

  it("answers 404 not_found for an unknown app", async () => {
    h.appDetail.mockResolvedValue(null);
    const r = await call("nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("not_found");
  });

  it("answers 404 for an absurdly long name without reading anything", async () => {
    expect((await call("x".repeat(101))).status).toBe(404);
    expect(h.appDetail).not.toHaveBeenCalled();
  });
});

describe("usage recording (stage 5c: Agents and Logs count REST calls)", () => {
  it("records /status and /status/apps through the shared writer with the final status; a failed auth records nothing", async () => {
    await GET(req());
    expect(h.recordApiCall).toHaveBeenLastCalledWith(key, "status", "status", expect.any(Number), 200);
    h.appDetail.mockResolvedValue(null);
    await GET_APP(new Request("https://watch.example.com/api/v1/status/apps/nope"), { params: Promise.resolve({ app: "nope" }) });
    expect(h.recordApiCall).toHaveBeenLastCalledWith(key, "status", "status/apps", expect.any(Number), 404);
    h.recordApiCall.mockClear();
    h.auth.mockResolvedValue({ ok: false, response: apiError("invalid_api_key", "no", 401) });
    await GET(req());
    expect(h.recordApiCall).not.toHaveBeenCalled();
  });
});
