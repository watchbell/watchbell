import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OFFICE = "/office/kantor-virtual.html";
const h = vi.hoisted(() => ({ updateSession: vi.fn(), staticPaths: [] as string[] }));
vi.mock("@/lib/supabase/proxy", () => ({ updateSession: h.updateSession }));
// The list differs per edition (the export ships an empty one; pinned in static-html.test.ts), so each test sets it.
vi.mock("@/lib/security/static-html", () => ({ OFFICE_FRAME_PATH: "/office/kantor-virtual.html", STATIC_HTML_PATHS: h.staticPaths }));

import { proxy } from "./proxy";

const T = "hb_0123456789abcdef0123456789abcdef";
const req = (path: string) => new NextRequest(`https://ops.example.com${path}`, { headers: { cookie: "sb-abc-auth-token=junk" } });

beforeEach(() => {
  h.staticPaths.splice(0, h.staticPaths.length, OFFICE); // the private edition's list
  h.updateSession.mockReset();
  h.updateSession.mockImplementation(async () => {
    const response = NextResponse.next();
    response.cookies.set("sb-abc-auth-token", "refreshed");
    return { response, userId: null };
  });
});

describe("proxy", () => {
  it("lets a ping through without reading or refreshing a session (U3, review I4)", async () => {
    for (const path of [`/api/ping/${T}`, `/api/ping/${T}/fail`, "/api/ping/nope"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.updateSession).not.toHaveBeenCalled();
  });

  it("still reads the session everywhere else, and sends a signed-out visitor to sign in", async () => {
    for (const path of ["/api/ping", "/api/pingx", "/uptime"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("location")).toMatch(/\/signin/);
    }
    expect(h.updateSession).toHaveBeenCalledTimes(3);
  });

  it("lets /api/v1/ through without session work: those calls authenticate by API key (5c, R2)", async () => {
    for (const path of ["/api/v1/ai/chat/completions", "/api/v1/mcp", "/api/v1/status"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.updateSession).not.toHaveBeenCalled();
  });

  it("lets the Telegram webhook through without session work: its secret header is the credential (Stage 9 slice 7)", async () => {
    const res = await proxy(req("/api/telegram/webhook"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.updateSession).not.toHaveBeenCalled();
    expect((await proxy(req("/api/telegram/webhookx"))).headers.get("location")).toMatch(/\/signin/);
  });

  it("lets the public status page through without session work, so it stays cacheable and costs no Auth call (U6)", async () => {
    for (const path of ["/s/acme", "/s/nope", "/s/acme/badge/web.svg"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(h.updateSession).not.toHaveBeenCalled();
  });

  it("keeps the session check next to the status page", async () => {
    for (const path of ["/s", "/sx", "/s-acme", "/settings", "/status"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("location")).toMatch(/\/signin/);
    }
    expect(h.updateSession).toHaveBeenCalledTimes(5);
  });

  it("keeps the session check for /api/v1 without a slash and for the explorer pages", async () => {
    for (const path of ["/api/v1", "/api/v1x", "/api-docs"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("location")).toMatch(/\/signin/);
    }
    expect(h.updateSession).toHaveBeenCalledTimes(3);
  });
});

describe("proxy in demo without a wp_demo cookie (more in proxy.demo.test.ts)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never asks Supabase: signed out, public paths stay open", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    for (const path of ["/", "/overview", "/settings"]) {
      expect((await proxy(req(path))).headers.get("location")).toMatch(/\/signin/);
    }
    for (const path of ["/signin", "/api/health"]) {
      expect((await proxy(req(path))).headers.get("location")).toBeNull();
    }
    expect(h.updateSession).not.toHaveBeenCalled();
  });

  // Watchbell 1.2.1: the enforced CSP with a per-request nonce, and the nonce forwarded to the render.
  describe("CSP (enforced)", () => {
    const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
    it("a page gets the policy with a fresh nonce, and the same policy and nonce reach the render on the request", async () => {
      h.updateSession.mockImplementation(async (r: NextRequest) => ({ response: NextResponse.next({ request: r }), userId: "u1" }));
      const a = await proxy(req("/settings"));
      const b = await proxy(req("/settings"));
      const policy = a.headers.get("content-security-policy");
      expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic' 'sha256-/);
      expect(nonceOf(policy)).not.toBe(nonceOf(b.headers.get("content-security-policy")));
      // What Next's render sees (NextResponse.next({ request }) forwards overridden request headers this way).
      expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(policy));
      expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    });

    it("the early-returning paths, redirects and the status pages get it too (status pages without a nonce)", async () => {
      for (const path of [`/api/ping/${T}`, "/api/v1/me", "/uptime"]) {
        expect((await proxy(req(path))).headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
      }
      const status = await proxy(req("/s/acme"));
      expect(status.headers.get("content-security-policy")).toMatch(/script-src 'self' 'unsafe-inline'/);
      expect(status.headers.get("x-middleware-request-x-nonce")).toBeNull();
    });

    // Review T2b-fix I-2: only the listed static file goes without a nonce, never any path ending in .html.
    it("a console path ending in .html keeps the nonce policy; only the office file goes without", async () => {
      h.updateSession.mockImplementation(async (r: NextRequest) => ({ response: NextResponse.next({ request: r }), userId: "u1" }));
      for (const path of ["/apps/x.html", "/anything.html", "/office/kantor-virtual.html/x", "/office/other.html"]) {
        const res = await proxy(req(path));
        expect(res.headers.get("content-security-policy")).toMatch(/'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/);
        expect(res.headers.get("content-security-policy")).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(res.headers.get("x-middleware-request-x-nonce")).not.toBeNull();
      }
      const office = await proxy(req("/office/kantor-virtual.html"));
      expect(office.headers.get("content-security-policy")).toMatch(/script-src 'self' 'unsafe-inline'/);
      expect(office.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self'/);
      expect((await proxy(req("/s/acme"))).headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    });

    // Review T2b-fix3 I-1: the open source edition has no office file, so there the path is a console page.
    it("with no static files listed (open source edition), the office path keeps the nonce policy", async () => {
      h.staticPaths.splice(0, h.staticPaths.length);
      h.updateSession.mockImplementation(async (r: NextRequest) => ({ response: NextResponse.next({ request: r }), userId: "u1" }));
      const res = await proxy(req(OFFICE));
      const policy = res.headers.get("content-security-policy");
      expect(policy).toMatch(/'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/);
      expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(policy).toMatch(/frame-ancestors 'none'/);
      expect(policy).not.toMatch(/fonts\.g/);
      expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(policy));
    });
  });
});
