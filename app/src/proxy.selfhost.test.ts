import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateSession: vi.fn(), updateSessionLocal: vi.fn(), userId: null as string | null }));
vi.mock("@/lib/supabase/proxy", () => ({ updateSession: h.updateSession }));
vi.mock("@/lib/local-auth/proxy", () => ({ updateSessionLocal: h.updateSessionLocal }));

import { proxy } from "./proxy";

const req = (path: string) => new NextRequest(`http://127.0.0.1:3100${path}`, { headers: { cookie: "wp_session=x" } });

beforeEach(() => {
  h.userId = null;
  h.updateSession.mockReset();
  h.updateSession.mockImplementation(async () => ({ response: NextResponse.next(), userId: null }));
  h.updateSessionLocal.mockReset();
  h.updateSessionLocal.mockImplementation(async () => {
    const response = NextResponse.next();
    if (!h.userId) response.cookies.set("wp_session", "", { path: "/", maxAge: 0 });
    return { response, userId: h.userId };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy in self-host", () => {
  beforeEach(() => vi.stubEnv("WATCHPOST_MODE", "selfhost"));

  it("reads the local session, never Supabase, and sends a signed-out visitor to sign in with the stale cookie cleared", async () => {
    const res = await proxy(req("/settings"));
    expect(res.headers.get("location")).toMatch(/:3100\/signin\?next=%2Fsettings$/);
    expect(res.headers.get("set-cookie")).toMatch(/^wp_session=; Path=\/; Max-Age=0/);
    expect(h.updateSessionLocal).toHaveBeenCalledTimes(1);
    expect(h.updateSession).not.toHaveBeenCalled();
  });

  it("lets a signed-in user through and away from /signin", async () => {
    h.userId = "u1";
    expect((await proxy(req("/settings"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/signin"))).headers.get("location")).toMatch(/:3100\/$/);
  });

  it("lets /setup through signed out", async () => {
    expect((await proxy(req("/setup"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/setupx"))).headers.get("location")).toMatch(/\/signin/);
  });
});

describe("proxy in cloud", () => {
  it("uses the Supabase session only, and /setup is not public", async () => {
    const res = await proxy(req("/setup"));
    expect(res.headers.get("location")).toMatch(/\/signin\?next=%2Fsetup/);
    expect(h.updateSession).toHaveBeenCalledTimes(1);
    expect(h.updateSessionLocal).not.toHaveBeenCalled();
  });
});
