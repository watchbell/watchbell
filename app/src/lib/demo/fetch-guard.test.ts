import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedFetch, installFetchGuard } from "./fetch-guard";
import { DemoUnavailable } from "./simulate";

const ok = () => Promise.resolve(new Response("ok"));

describe("guardedFetch (the demo never calls a real provider)", () => {
  beforeEach(() => vi.stubEnv("SITE_URL", "https://demo.example.test"));
  afterEach(() => vi.unstubAllEnvs());

  it("rejects an absolute request to another origin without calling through", async () => {
    const inner = vi.fn(ok);
    const f = guardedFetch(inner);
    await expect(f("https://api.vercel.com/v9/projects")).rejects.toThrow("Not available in the demo");
    await expect(f(new URL("https://api.telegram.org/bot1/getMe"))).rejects.toThrow("Not available in the demo");
    await expect(f(new Request("https://api.resend.com/emails", { method: "POST" }))).rejects.toBeInstanceOf(DemoUnavailable);
    // Neither a string, a URL nor a Request: judged by what it turns into as a string.
    await expect(f({ toString: () => "https://api.vercel.com/v9/projects" } as unknown as string)).rejects.toThrow("Not available in the demo");
    expect(inner).not.toHaveBeenCalled();
  });

  it("allows absolute URLs on the SITE_URL origin, refusing redirects unless the caller chose otherwise", async () => {
    const inner = vi.fn(ok);
    const f = guardedFetch(inner);
    await f("https://demo.example.test/overview?x=1");
    await f(new URL("https://demo.example.test/api/health"), { method: "POST" });
    await f(new Request("https://demo.example.test/api/health"));
    await f("https://demo.example.test/api/health", { redirect: "manual" });
    expect(inner).toHaveBeenCalledTimes(4);
    expect(inner.mock.calls.map((c) => (c as unknown as [unknown, RequestInit])[1].redirect)).toEqual(["error", "error", "error", "manual"]);
    expect((inner.mock.calls[1] as unknown as [unknown, RequestInit])[1].method).toBe("POST");
  });

  it("rejects relative paths: server-side there is no page to resolve them against", async () => {
    const inner = vi.fn(ok);
    const f = guardedFetch(inner);
    for (const url of ["/api/health", "api/health", "?x=1"]) await expect(f(url), url).rejects.toThrow("Not available in the demo");
    expect(inner).not.toHaveBeenCalled();
  });

  it("rejects look-alikes: protocol-relative, another port, subdomain, userinfo, backslash tricks, unparsable", async () => {
    const inner = vi.fn(ok);
    const f = guardedFetch(inner);
    for (const url of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://demo.example.test:8443/x",
      "http://demo.example.test/x",
      "https://demo.example.test.evil.test/x",
      "https://demo.example.test@evil.test/x",
      "https://sub.demo.example.test/x",
      "data:text/plain,hi",
      "not a url",
      "",
    ]) {
      await expect(f(url), url).rejects.toThrow("Not available in the demo");
    }
    expect(inner).not.toHaveBeenCalled();
  });

  // Follow-up A4: blocked calls log at most one short debug line, naming the origin only (a path can carry a token).
  it("logs one short debug line per blocked call, with the origin only, and nothing louder", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const loud = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    try {
      const f = guardedFetch(vi.fn(ok));
      await expect(f("https://api.telegram.org/bot123:SECRET/getMe")).rejects.toBeInstanceOf(DemoUnavailable);
      await expect(f("not a url")).rejects.toBeInstanceOf(DemoUnavailable);
      expect(debug.mock.calls).toEqual([["demo: outbound fetch blocked (https://api.telegram.org)"], ["demo: outbound fetch blocked (not an absolute URL)"]]);
      for (const s of loud) expect(s).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Next's own fetch of the page a Server Action redirects to (next/dist/server/app-render/action-handler.js) goes to
  // the address the server listens on, which is not SITE_URL behind a proxy. It stays blocked; instead of throwing (Next
  // then console.errors "failed to get redirect response" with the whole stack) it gets an empty non-RSC answer, which
  // makes Next fall back to the plain redirect it would have done anyway. Nothing is logged for it.
  it("answers Next's internal Server Action redirect fetch with an empty response, without calling through or logging", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const inner = vi.fn(ok);
      const f = guardedFetch(inner);
      const res = await f(new URL("http://localhost:3000/signin"), { method: "GET", headers: { rsc: "1" }, next: { internal: 1 } } as RequestInit);
      expect(res.status).toBe(204);
      expect(res.headers.get("content-type")).toBeNull();
      expect(await res.text()).toBe("");
      expect(inner).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
      // Without Next's internal marker the same call is an ordinary blocked fetch.
      await expect(f(new URL("http://localhost:3000/signin"), { method: "GET", headers: { rsc: "1" } })).rejects.toBeInstanceOf(DemoUnavailable);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("with no SITE_URL nothing passes", async () => {
    vi.stubEnv("SITE_URL", "");
    const inner = vi.fn(ok);
    const f = guardedFetch(inner);
    await expect(f("/api/health")).rejects.toThrow("Not available in the demo");
    await expect(f("https://demo.example.test/x")).rejects.toThrow("Not available in the demo");
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("installFetchGuard", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    delete (globalThis as { __watchpostFetchGuard?: boolean }).__watchpostFetchGuard;
  });

  it("replaces the global fetch once, and a second call does not stack another wrapper", async () => {
    const inner = vi.fn(ok);
    globalThis.fetch = inner as unknown as typeof fetch;
    installFetchGuard();
    const installed = globalThis.fetch;
    expect(installed).not.toBe(inner);
    installFetchGuard();
    expect(globalThis.fetch).toBe(installed);
    await expect(fetch("https://api.vercel.com/v9/projects")).rejects.toThrow("Not available in the demo");
    expect(inner).not.toHaveBeenCalled();
  });
});
