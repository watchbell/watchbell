import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock("@/lib/supabase/proxy", () => ({ updateSession: h.updateSession }));

import { proxy } from "./proxy";

const T = "hb_0123456789abcdef0123456789abcdef";
const req = (path: string) => new NextRequest(`https://ops.example.com${path}`, { headers: { cookie: "sb-abc-auth-token=junk" } });

beforeEach(() => {
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
});
