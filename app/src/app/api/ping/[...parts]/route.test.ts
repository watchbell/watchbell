import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as unknown[][], answer: "ok" as "ok" | "unknown" | "limited" | "throw" }));
vi.mock("@/lib/data/heartbeats-db", () => ({
  recordPing: async (...a: unknown[]) => {
    h.calls.push(a);
    if (h.answer === "throw") throw new Error(`select where token_hash = ${String(a[0])}`);
    return h.answer === "limited" ? { status: "limited", retryAfter: 137 } : { status: h.answer };
  },
}));
import { PING_MISSES_PER_IP, PING_PER_IP, pingThrottle } from "@/lib/ping-throttle";
import { GET, HEAD, POST } from "./route";

const T = "hb_0123456789abcdef0123456789abcdef";
const req = (path: string, init?: RequestInit) => new Request(`https://ops.example.com/api/ping/${path}`, init);
const ctx = (parts: string[]) => ({ params: Promise.resolve({ parts }) });

beforeEach(() => { h.calls = []; h.answer = "ok"; pingThrottle.reset(); });

describe("/api/ping", () => {
  it("records an ok ping and answers OK without caching", async () => {
    const res = await GET(req(T), ctx([T]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.calls[0].slice(0, 2)).toEqual([T, "ok"]);
  });
  it("records /fail from a POST and never reads the body", async () => {
    const body = new ReadableStream({ pull() { throw new Error("body was read"); } });
    const res = await POST(req(`${T}/fail`, { method: "POST", body, duplex: "half" } as RequestInit), ctx([T, "fail"]));
    expect(res.status).toBe(200);
    expect(h.calls[0].slice(0, 2)).toEqual([T, "fail"]);
  });
  it("answers 404 for a malformed token without touching the database", async () => {
    const res = await GET(req("nope"), ctx(["nope"]));
    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });
  it("answers 404 for an unknown token and 429 when limited", async () => {
    h.answer = "unknown";
    expect((await GET(req(T), ctx([T]))).status).toBe(404);
    pingThrottle.reset();
    h.answer = "limited";
    const limited = await GET(req(T), ctx([T]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("137");
  });
  it("records a HEAD ping like a GET", async () => {
    expect((await HEAD(req(`${T}/start`), ctx([T, "start"]))).status).toBe(200);
    expect(h.calls[0].slice(0, 2)).toEqual([T, "start"]);
  });
  it("answers 503 when the database fails, and logs the error's name only, never the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.answer = "throw";
    const res = await GET(req(T), ctx([T]));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(warn).toHaveBeenCalledWith("ping failed:", "Error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(T);
    warn.mockRestore();
  });

  // Watchbell 1.2.1 (audit M2): throttled in memory before the database.
  const fromIp = (path: string, ip = "203.0.113.9") => new Request(`https://ops.example.com/api/ping/${path}`, { headers: { "x-real-ip": ip } });
  const tok = (i: number) => `hb_${i.toString(16).padStart(32, "0")}`;

  it("remembers an unknown token for a minute: the next ping with it doesn't reach the database", async () => {
    h.answer = "unknown";
    expect((await GET(req(T), ctx([T]))).status).toBe(404);
    expect((await GET(req(T), ctx([T]))).status).toBe(404);
    expect(h.calls).toHaveLength(1);
  });

  it("limits pings per IP: past the limit a 429 with Retry-After, without the database; other IPs go on", async () => {
    for (let i = 0; i < PING_PER_IP.max; i++) expect((await GET(fromIp(T), ctx([T]))).status).toBe(200);
    const limited = await GET(fromIp(T), ctx([T]));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.calls).toHaveLength(PING_PER_IP.max);
    expect((await GET(fromIp(T, "198.51.100.7"), ctx([T]))).status).toBe(200);
  });

  // Review I3: a host whose crons still ping deleted heartbeats keeps its live heartbeats.
  it("stale tokens pinged every minute for 10 minutes count once each: a known token from that host still gets 200", async () => {
    const stale = [tok(1), tok(2), tok(3)];
    for (let minute = 0; minute < 10; minute++) {
      pingThrottle.unknown.reset(); // the one-minute memory of unknown tokens has run out
      h.answer = "unknown";
      for (const s of stale) expect((await GET(fromIp(s), ctx([s]))).status).toBe(404);
      h.answer = "ok";
      expect((await GET(fromIp(T), ctx([T]))).status).toBe(200);
    }
  });

  it("an IP that keeps sending unknown tokens is refused before the database", async () => {
    h.answer = "unknown";
    for (let i = 0; i < PING_MISSES_PER_IP.max; i++) expect((await GET(fromIp(tok(i)), ctx([tok(i)]))).status).toBe(404);
    const n = h.calls.length;
    expect((await GET(fromIp(tok(999)), ctx([tok(999)]))).status).toBe(429);
    expect(h.calls).toHaveLength(n);
  });
});
