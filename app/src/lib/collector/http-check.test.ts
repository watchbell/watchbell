import { describe, expect, it, vi } from "vitest";
import { checkUrl, MAX_REDIRECTS, mapLimit, safeGet } from "./http-check";

const clock = () => { let t = 0; return () => (t += 120); };
const PUBLIC = ["93.184.216.34"];
const publicLookup = vi.fn<(host: string) => Promise<string[]>>(async () => PUBLIC);
const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

describe("checkUrl", () => {
  it("passes when the final status matches and records latency", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await checkUrl("https://a.example/", { fetch, clock: clock(), lookup: publicLookup })).toEqual({ ok: true, statusCode: 200, latencyMs: 120, error: null });
    expect(fetch).toHaveBeenCalledWith("https://a.example/", expect.objectContaining({ method: "GET", redirect: "manual" }));
  });
  it("fails on an unexpected status", async () => {
    const fetch = vi.fn(async () => new Response("bad", { status: 502 }));
    expect(await checkUrl("https://a.example/", { fetch, clock: clock(), lookup: publicLookup })).toEqual({ ok: false, statusCode: 502, latencyMs: 120, error: "HTTP 502" });
  });
  it("reports timeouts and connection errors in words", async () => {
    const timeout = vi.fn(async () => { throw new DOMException("t", "TimeoutError"); });
    expect(await checkUrl("https://a.example/", { fetch: timeout, timeoutMs: 5000, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "No answer within 5 s" });
    const broken = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await checkUrl("https://a.example/", { fetch: broken, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "Couldn't connect" });
  });
  it("aborts a hanging request at the timeout and words sub-second timeouts in ms", async () => {
    const hang = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal?.reason));
    }));
    expect(await checkUrl("https://a.example/", { fetch: hang, timeoutMs: 20, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "No answer within 20 ms" });
  });
  it("gives a hanging DNS lookup the same timeout", async () => {
    const fetch = vi.fn();
    const lookup = vi.fn(() => new Promise<string[]>(() => undefined));
    expect(await checkUrl("https://a.example/", { fetch, timeoutMs: 20, lookup })).toMatchObject({ ok: false, error: "No answer within 20 ms" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports a failed lookup as a connection error", async () => {
    const fetch = vi.fn();
    const lookup = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    expect(await checkUrl("https://a.example/", { fetch, lookup })).toMatchObject({ ok: false, statusCode: null, error: "Couldn't connect" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still words fetch's own redirect-loop error as too many redirects", async () => {
    const loop = vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") }); });
    expect(await checkUrl("https://a.example/", { fetch: loop, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "Too many redirects" });
  });
});

describe("checkUrl: private addresses", () => {
  it.each([
    "https://127.0.0.1/", "https://localhost/", "https://app.internal/", "https://169.254.169.254/latest/meta-data", "https://[::1]/",
    "https://10.0.0.5/", "https://a.example:8443/", "http://a.example/", "https://u:p@a.example/",
  ])("refuses %s without a lookup or a request", async (url) => {
    const fetch = vi.fn();
    const lookup = vi.fn<(host: string) => Promise<string[]>>(async () => PUBLIC);
    expect(await checkUrl(url, { fetch, lookup })).toEqual({ ok: false, statusCode: null, latencyMs: null, error: "Blocked address" });
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
  it("refuses a name when ANY of its addresses is private", async () => {
    const fetch = vi.fn();
    const lookup = vi.fn(async () => ["93.184.216.34", "10.0.0.8"]);
    expect(await checkUrl("https://rebind.example/", { fetch, lookup })).toMatchObject({ ok: false, error: "Blocked address" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a name that resolves to an IPv4-mapped private IPv6 address", async () => {
    const lookup = vi.fn(async () => ["::ffff:127.0.0.1"]);
    expect(await checkUrl("https://x.example/", { fetch: vi.fn(), lookup })).toMatchObject({ error: "Blocked address" });
  });
  it("treats a name that resolves to nothing as a connection error", async () => {
    const lookup = vi.fn(async () => [] as string[]);
    expect(await checkUrl("https://x.example/", { fetch: vi.fn(), lookup })).toMatchObject({ ok: false, error: "Couldn't connect" });
  });
  it("doesn't look up a public IP literal", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const lookup = vi.fn<(host: string) => Promise<string[]>>(async () => PUBLIC);
    expect(await checkUrl("https://8.8.8.8/", { fetch, lookup })).toMatchObject({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("checkUrl: redirects are followed by hand", () => {
  it("follows a public redirect, resolving a relative Location, and compares the final status", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(redirect(301, "/en/"))
      .mockResolvedValueOnce(redirect(302, "https://b.example/home"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const lookup = vi.fn<(host: string) => Promise<string[]>>(async () => PUBLIC);
    const r = await checkUrl("https://a.example/", { fetch, clock: clock(), lookup });
    expect(r).toEqual({ ok: true, statusCode: 200, latencyMs: 120, error: null });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://a.example/", "https://a.example/en/", "https://b.example/home"]);
    expect(lookup).toHaveBeenCalledWith("b.example");
  });
  it("refuses a redirect to a private address, and never requests it", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(302, "https://127.0.0.1/admin"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "Blocked address" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses an https to http downgrade", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(301, "http://a.example/"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ error: "Blocked address" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses a redirect to a plain-http loopback port", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(307, "http://127.0.0.1:3000/"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ error: "Blocked address" });
  });
  it("re-resolves every hop: a name that now resolves privately is refused", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(302, "https://evil.example/"));
    const lookup = vi.fn(async (host: string) => (host === "evil.example" ? ["192.168.1.10"] : PUBLIC));
    expect(await checkUrl("https://a.example/", { fetch, lookup })).toMatchObject({ error: "Blocked address" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses a redirect to another port", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(302, "https://a.example:8443/"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ error: "Blocked address" });
  });
  it("gives up on a loop with the usual message", async () => {
    const fetch = vi.fn(async () => redirect(302, "/again"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ ok: false, statusCode: null, error: "Too many redirects" });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
  });
  it("treats a redirect status without a Location as the answer", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup, expectedStatus: 304 })).toMatchObject({ ok: true, statusCode: 304 });
  });
  it("refuses a Location it cannot parse", async () => {
    const fetch = vi.fn(async () => redirect(302, "https://"));
    expect(await checkUrl("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ ok: false, error: "Blocked address" });
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});

describe("safeGet: the same guard, keeping a capped body", () => {
  it("returns the status, the final address after redirects, and the body text", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(redirect(308, "https://www.a.example/"))
      .mockResolvedValueOnce(new Response("<html>hi</html>", { status: 200 }));
    const lookup = vi.fn<(host: string) => Promise<string[]>>(async () => PUBLIC);
    expect(await safeGet("https://a.example/", { fetch, lookup })).toEqual({
      ok: true, status: 200, url: "https://www.a.example/", body: "<html>hi</html>", truncated: false,
    });
    expect(lookup).toHaveBeenCalledWith("www.a.example");
    expect(fetch).toHaveBeenLastCalledWith("https://www.a.example/", expect.objectContaining({ method: "GET", redirect: "manual" }));
  });
  it("refuses a private address or a redirect to one, without requesting it", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(302, "https://10.0.0.1/"));
    expect(await safeGet("https://127.0.0.1/", { fetch: vi.fn(), lookup: publicLookup })).toEqual({ ok: false, error: "Blocked address" });
    expect(await safeGet("https://a.example/", { fetch, lookup: publicLookup })).toEqual({ ok: false, error: "Blocked address" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("stops reading at the byte cap and cancels the rest", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new TextEncoder().encode("abcdefghij")); },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const r = await safeGet("https://a.example/big.js", { fetch, lookup: publicLookup, maxBytes: 25 });
    expect(r).toEqual({ ok: true, status: 200, url: "https://a.example/big.js", body: "abcdefghijabcdefghijabcde", truncated: true });
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });
  it("words a timeout and an outside abort like the monitors do", async () => {
    const hang = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
    }));
    expect(await safeGet("https://a.example/", { fetch: hang, lookup: publicLookup, timeoutMs: 20 })).toEqual({ ok: false, error: "No answer within 20 ms" });
    const outside = new AbortController();
    const p = safeGet("https://a.example/", { fetch: hang, lookup: publicLookup, timeoutMs: 5000, signal: outside.signal });
    outside.abort();
    expect(await p).toEqual({ ok: false, error: "No answer within 5 s" });
  });
  it("gives up on a body that stalls at the timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } });
    const fetch = vi.fn(async () => new Response(stalled, { status: 200 }));
    expect(await safeGet("https://a.example/", { fetch, lookup: publicLookup, timeoutMs: 30 })).toEqual({ ok: false, error: "No answer within 30 ms" });
  });
  it("reports a connection failure", async () => {
    const broken = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await safeGet("https://a.example/", { fetch: broken, lookup: publicLookup })).toEqual({ ok: false, error: "Couldn't connect" });
  });
});

describe("safeGet: same origin only (script reads)", () => {
  it("refuses a redirect to another origin, without requesting it", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect(302, "https://cdn.other.example/_next/static/x.js"));
    expect(await safeGet("https://a.example/_next/static/x.js", { fetch, lookup: publicLookup, sameOrigin: true })).toEqual({
      ok: false, error: "Redirected to another site",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("follows a redirect that stays on the same origin", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(redirect(307, "/_next/static/y.js"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await safeGet("https://a.example/_next/static/x.js", { fetch, lookup: publicLookup, sameOrigin: true })).toMatchObject({
      ok: true, url: "https://a.example/_next/static/y.js",
    });
  });
  it("leaves cross-origin redirects alone without the option (the page read)", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(redirect(308, "https://www.a.example/"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await safeGet("https://a.example/", { fetch, lookup: publicLookup })).toMatchObject({ ok: true, url: "https://www.a.example/" });
  });
});

describe("safeGet: truncated", () => {
  it("is false when the body is exactly the cap", async () => {
    const fetch = vi.fn(async () => new Response("abcdefghij", { status: 200 }));
    expect(await safeGet("https://a.example/", { fetch, lookup: publicLookup, maxBytes: 10 })).toMatchObject({ body: "abcdefghij", truncated: false });
  });
});

describe("checkUrl with a body rule", () => {
  it("fails a 200 whose body lacks the keyword, and keeps the status code", async () => {
    const r = await checkUrl("https://site.example.com/health", { fetch: async () => new Response("all good"), lookup: publicLookup, body: { kind: "contains", text: "ok" } });
    expect(r).toMatchObject({ ok: false, statusCode: 200, error: "Keyword not found" });
  });
  it("passes when the JSON value matches, and doesn't read a body without a rule", async () => {
    const json = async () => new Response('{"status":"ok"}');
    expect(await checkUrl("https://site.example.com/health", { fetch: json, lookup: publicLookup, body: { kind: "json", path: "status", equals: "ok" } })).toMatchObject({ ok: true, error: null });
    expect(await checkUrl("https://site.example.com/health", { fetch: json, lookup: publicLookup })).toMatchObject({ ok: true });
  });
  it("doesn't judge the body of a wrong status", async () => {
    const r = await checkUrl("https://site.example.com/", { fetch: async () => new Response("ok", { status: 503 }), lookup: publicLookup, body: { kind: "contains", text: "ok" } });
    expect(r).toMatchObject({ ok: false, statusCode: 503, error: "HTTP 503" });
  });
  it("keeps the status when the server answered but the body stalls, and says the body wasn't read", async () => {
    const stalled = async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start() { /* never delivers */ } });
      return new Response(body, { status: 200, signal: init?.signal } as ResponseInit);
    };
    const r = await checkUrl("https://site.example.com/", { fetch: stalled as typeof fetch, lookup: publicLookup, timeoutMs: 30, body: { kind: "contains", text: "ok" } });
    expect(r).toMatchObject({ ok: false, statusCode: 200, error: "Body not read within 30 ms" });
    expect(r.latencyMs).not.toBeNull();
  });
  it("cuts a long body at 256 KB and says so when the keyword isn't in the part it read", async () => {
    const big = "a".repeat(300 * 1024) + "ok";
    const r = await checkUrl("https://site.example.com/", { fetch: async () => new Response(big), lookup: publicLookup, body: { kind: "contains", text: "ok" } });
    expect(r).toMatchObject({ ok: false, statusCode: 200, error: "Keyword not found in the first 256 KB" });
  });
});
