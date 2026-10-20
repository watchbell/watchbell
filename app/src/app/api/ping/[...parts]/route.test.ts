import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as unknown[][], answer: "ok" as "ok" | "unknown" | "limited" | "throw" }));
vi.mock("@/lib/data/heartbeats-db", () => ({
  recordPing: async (...a: unknown[]) => {
    h.calls.push(a);
    if (h.answer === "throw") throw new Error(`select where token_hash = ${String(a[0])}`);
    return h.answer === "limited" ? { status: "limited", retryAfter: 137 } : { status: h.answer };
  },
}));
import { GET, HEAD, POST } from "./route";

const T = "hb_0123456789abcdef0123456789abcdef";
const req = (path: string, init?: RequestInit) => new Request(`https://ops.example.com/api/ping/${path}`, init);
const ctx = (parts: string[]) => ({ params: Promise.resolve({ parts }) });

beforeEach(() => { h.calls = []; h.answer = "ok"; });

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
});
