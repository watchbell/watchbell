import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/private/api/respond";

const h = vi.hoisted(() => ({ auth: vi.fn(), items: vi.fn(), counts: vi.fn(), recordApiCall: vi.fn(), now: 1_000_000 }));
vi.mock("@/private/ai/usage", () => ({ recordApiCall: h.recordApiCall }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/private/console/snapshot", () => ({ snapMonitorItems: h.items, snapAlertCounts: h.counts }));

import { metricsMemo } from "@/private/console/metrics-read";
import { GET } from "./route";

const key = { keyId: "k1", name: "grafana", prefix: "wb_abcd", scopes: ["read:status"], ratePerMin: 20, providerId: null, model: null, client: { name: "x", version: "", via: "unknown", userAgent: "" } };
const req = () => new Request("https://watch.example.com/api/v1/metrics", { headers: { authorization: "Bearer wb_x" } });
const monitor = { app: "Toko utama", path: "/", kind: "http", state: "up", lastStatus: 200, latencyMs: 250, uptime30d: 99.85, lastCheckedAt: null, workspace: "Personal" };

beforeEach(() => {
  vi.resetAllMocks();
  metricsMemo.clear();
  h.auth.mockResolvedValue({ ok: true, key });
  h.items.mockResolvedValue([monitor]);
  h.counts.mockResolvedValue({ critical: 1 });
});

describe("GET /api/v1/metrics (1.8.5)", () => {
  it("asks for read:status and passes a failed authentication through without reading the console", async () => {
    h.auth.mockResolvedValue({ ok: false, response: apiError("invalid_api_key", "no", 401) });
    const r = await GET(req());
    expect(r.status).toBe(401);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "read:status");
    expect(h.items).not.toHaveBeenCalled();
  });

  it("answers the Prometheus text format, never cached by a CDN, and records the call", async () => {
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(r.headers.get("cache-control")).toContain("no-store");
    const body = await r.text();
    expect(body).toContain('watchbell_monitor_up{app="Toko utama",path="/",kind="http",workspace="Personal"} 1\n');
    expect(body).toContain('watchbell_alerts_open{severity="critical"} 1\n');
    // Final review 1.8.5 M1: a scrape every 15 s would write ~5,800 usage rows a day; only failures are recorded.
    expect(h.recordApiCall).not.toHaveBeenCalled();
  });

  it("reads the database at most once a minute however often it is scraped", async () => {
    await GET(req());
    await GET(req());
    await GET(req());
    expect(h.items).toHaveBeenCalledTimes(1);
    expect(h.counts).toHaveBeenCalledTimes(1);
  });

  it("a failed read answers 502 and is not kept", async () => {
    h.items.mockRejectedValueOnce(new Error("db down"));
    expect((await GET(req())).status).toBe(502);
    expect(h.recordApiCall).toHaveBeenCalledWith(key, "status", "metrics", expect.any(Number), 502);
    expect((await GET(req())).status).toBe(200);
  });
});
