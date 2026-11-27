import { beforeEach, describe, expect, it, vi } from "vitest";

const SRC = { id: "s1", kind: "alertmanager", name: "Alertmanager", tokenHash: "h", tokenPrefix: "am_8f2k", enabled: true, createdAt: new Date(), lastSeenAt: null, monthKey: null, receivedMonth: 0, refusedMonth: 0 };
const h = vi.hoisted(() => ({
  after: vi.fn(), find: vi.fn(), apply: vi.fn(), count: vi.fn(), hit: vi.fn(), deliver: vi.fn(),
}));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/data/ingest-db", () => ({ findSourceByHash: h.find, applyExternalAlerts: h.apply, countIngest: h.count }));
vi.mock("@/lib/rate-limit-db", () => ({ hitLimit: h.hit }));
vi.mock("@/lib/data/notify-db", () => ({ deliverPending: h.deliver }));

import { tokenHash } from "@/lib/heartbeat-token";
import { AM_PER_MINUTE } from "@/lib/ingest/alertmanager";
import { ingestThrottle } from "@/lib/ingest/throttle";
import { POST } from "./route";

const T = "am_8f2kQwErTyUiPaSdFgHjKz";
const alert = (fp: string) => ({ status: "firing", labels: { alertname: "HighErrorRate", job: "pos-api", severity: "critical" }, annotations: { summary: "5xx" }, startsAt: "2026-11-25T09:52:00Z", fingerprint: fp });
const body = (alerts: unknown[]) => JSON.stringify({ version: "4", status: "firing", receiver: "watchbell", alerts });
const call = (token: string, init: RequestInit = {}) =>
  POST(new Request(`https://ops.example.com/api/alertmanager/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" }, body: body([alert("a1"), alert("a2")]), ...init }), { params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.resetAllMocks();
  ingestThrottle.reset();
  h.find.mockResolvedValue(SRC);
  h.apply.mockResolvedValue({ opened: 2, touched: 0, resolved: 0 });
  h.hit.mockResolvedValue({ allowed: true, retryAfter: 0, count: 2, windowStart: new Date() });
  h.deliver.mockResolvedValue({ sent: 0, dropped: 0 });
});

describe("POST /api/alertmanager/{token}", () => {
  it("accepts a version 4 body, applies it, counts it and sends the notices after the response", async () => {
    const r = await call(T);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accepted: 2 });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(h.find).toHaveBeenCalledWith(tokenHash(T));
    expect(h.hit).toHaveBeenCalledWith({ name: "alertmanager", max: AM_PER_MINUTE, windowSeconds: 60 }, "s1", 2);
    expect(h.apply.mock.calls[0][1].map((a: { subject: string }) => a.subject)).toEqual(["am:a1", "am:a2"]);
    expect(h.count).toHaveBeenCalledWith(SRC, 2, 0, expect.any(Date));
    expect(h.after).toHaveBeenCalledTimes(1);
    await h.after.mock.calls[0][0]();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a token of the wrong shape without touching the database", async () => {
    for (const t of ["nope", "hb_0123456789abcdef0123456789abcdef", `${T}x`]) expect((await call(t)).status).toBe(404);
    expect(h.find).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown or revoked token, and remembers it for a minute", async () => {
    h.find.mockResolvedValue(null);
    expect((await call(T)).status).toBe(404);
    expect((await call(T)).status).toBe(404);
    expect(h.find).toHaveBeenCalledTimes(1);
  });

  it("answers 413 for a body over 256 KB, even without a Content-Length", async () => {
    const big = new TextEncoder().encode("x".repeat(300_000));
    const stream = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
    const r = await call(T, { body: stream, duplex: "half" } as RequestInit);
    expect(r.status).toBe(413);
    expect(h.apply).not.toHaveBeenCalled();
    const lying = await call(T, { body: "x".repeat(300_000), headers: { "content-length": "10", "x-real-ip": "203.0.113.9" } });
    expect(lying.status).toBe(413);
  });

  it("answers 400 for a body that isn't JSON or isn't version 4, and counts it as refused", async () => {
    expect((await call(T, { body: "{not json" })).status).toBe(400);
    expect((await call(T, { body: JSON.stringify({ version: "3", alerts: [] }) })).status).toBe(400);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.count).toHaveBeenCalledWith(SRC, 0, 1, expect.any(Date));
  });

  it("answers 429 with Retry-After when the source sends more than 120 alerts a minute", async () => {
    h.hit.mockResolvedValue({ allowed: false, retryAfter: 41, count: AM_PER_MINUTE + 1, windowStart: new Date() });
    const r = await call(T);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("41");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.count).toHaveBeenCalledWith(SRC, 0, 2, expect.any(Date));
  });

  it("answers 503 when the database fails, and logs only the error's name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.apply.mockRejectedValue(new Error(`insert ... ${T}`));
    const r = await call(T);
    expect(r.status).toBe(503);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(T);
    warn.mockRestore();
  });

  it("refuses an IP that floods it before any database read", async () => {
    for (let i = 0; i < 120; i++) await call(T);
    const r = await call(T);
    expect(r.status).toBe(429);
  });
});
