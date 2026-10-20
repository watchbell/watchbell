import { describe, expect, it, vi } from "vitest";
import { fetchSupabaseMetrics, isProjectRef, isSecretKey, metricsUrl } from "./supabase-metrics";

const REF = "abcdefghijklmnopqrst";
const KEY = "sb_secret" + "_FAKE_test_key_not_real_0000";

// Every call goes to an injected fetch: no network.
const answer = (status: number, body = "", headers: Record<string, string> = {}) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { status, headers }));

describe("fetchSupabaseMetrics", () => {
  it("GETs the project's privileged metrics with Basic service_role:<key>, no-store, the key never in the URL", async () => {
    const f = answer(200, "# HELP up x\nup 1\n");
    expect(await fetchSupabaseMetrics(REF, KEY, { fetch: f as unknown as typeof fetch })).toEqual({ ok: true, data: "# HELP up x\nup 1\n" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${REF}.supabase.co/customer/v1/privileged/metrics`);
    expect(url).not.toContain(KEY);
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString()).toBe(`service_role:${KEY}`);
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
  });

  it("names a rejected key, a missing endpoint, rate limits and server errors without echoing the key", async () => {
    for (const [status, kind] of [[401, "auth"], [403, "auth"], [404, "missing"], [429, "transient"], [500, "transient"]] as const) {
      const r = await fetchSupabaseMetrics(REF, KEY, { fetch: answer(status, "nope") as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: false, kind, status });
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  it("reports a timeout and a network error as transient", async () => {
    const timeout = vi.fn(async () => { throw new DOMException("t", "TimeoutError"); });
    expect(await fetchSupabaseMetrics(REF, KEY, { fetch: timeout as unknown as typeof fetch, timeoutMs: 8000 }))
      .toEqual({ ok: false, kind: "transient", error: "Supabase Metrics API didn't answer within 8 seconds." });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await fetchSupabaseMetrics(REF, KEY, { fetch: down as unknown as typeof fetch })).toMatchObject({ ok: false, kind: "transient" });
  });

  it("refuses an answer that isn't Prometheus text, and a bad ref before any call", async () => {
    expect(await fetchSupabaseMetrics(REF, KEY, { fetch: answer(200, "<html>login</html>") as unknown as typeof fetch })).toMatchObject({ ok: false, kind: "format" });
    const f = answer(200, "up 1");
    expect(await fetchSupabaseMetrics("evil.com/x?", KEY, { fetch: f as unknown as typeof fetch })).toMatchObject({ ok: false, kind: "format" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("validators", () => {
  it("accepts only project refs and sb_secret_ keys", () => {
    expect(isProjectRef(REF)).toBe(true);
    expect(isProjectRef("ABC")).toBe(false);
    expect(isProjectRef("a.b")).toBe(false);
    expect(isSecretKey(KEY)).toBe(true);
    expect(isSecretKey("sb_publishable_abcdefghijk")).toBe(false);
    expect(isSecretKey("eyJhbGciOiJIUzI1NiJ9.x.y")).toBe(false);
    expect(isSecretKey(`${KEY} `)).toBe(false);
    expect(metricsUrl(REF)).toMatch(/^https:\/\/abcdefghijklmnopqrst\.supabase\.co\//);
  });
});
