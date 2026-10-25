import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY_B64 = Buffer.alloc(32, 4).toString("base64");
const h = vi.hoisted(() => ({ updateSession: vi.fn(), updateSessionLocal: vi.fn() }));
vi.mock("@/lib/supabase/proxy", () => ({ updateSession: h.updateSession }));
vi.mock("@/lib/local-auth/proxy", () => ({ updateSessionLocal: h.updateSessionLocal }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64 }) }));

import { demoCookieKey, signDemoCookie } from "@/lib/demo/cookie";
import { proxy } from "./proxy";

const KEY = demoCookieKey(KEY_B64);
const SEED = "0123456789abcdef0123456789abcdef";
const req = (path: string, cookie?: string) => new NextRequest(`http://127.0.0.1:3100${path}`, cookie === undefined ? {} : { headers: { cookie: `wp_demo=${cookie}` } });
const cleared = (res: Response) => /^wp_demo=; Path=\/; Max-Age=0;.*HttpOnly.*SameSite=lax/i.test(res.headers.get("set-cookie") ?? "");

beforeEach(() => {
  vi.stubEnv("WATCHPOST_MODE", "demo");
  h.updateSession.mockReset();
  h.updateSessionLocal.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy in demo (cookie check only)", () => {
  it("lets a visitor with a valid signed cookie through, and away from /signin", async () => {
    const cookie = signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY);
    const res = await proxy(req("/settings", cookie));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await proxy(req("/signin", cookie))).headers.get("location")).toMatch(/:3100\/$/);
  });

  it("sends a visitor without a cookie to sign in, setting nothing", async () => {
    const res = await proxy(req("/settings"));
    expect(res.headers.get("location")).toMatch(/:3100\/signin\?next=%2Fsettings$/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await proxy(req("/signin"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("treats a tampered, expired or foreign cookie as signed out and clears it (Review Focus 2)", async () => {
    const good = signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY);
    const [payload, mac] = good.split(".");
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = (patch: object) => `${Buffer.from(JSON.stringify({ ...body, ...patch })).toString("base64url")}.${mac}`;
    for (const cookie of [
      forged({ email: "demo@watchbell.west-solutions.web.id" }),
      forged({ seed: "f".repeat(32) }),
      forged({ iat: body.iat + 1 }),
      `${payload}.${"A".repeat(43)}`,
      signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY, Date.now() - 8 * 24 * 60 * 60 * 1000),
      signDemoCookie({ email: "ana@visitor.test", seed: SEED }, Buffer.alloc(32, 9)),
      signDemoCookie({ email: "ana@visitor.test", seed: SEED }, Buffer.from(KEY_B64, "base64")), // the raw key, not the sub-key
      "junk",
    ]) {
      const res = await proxy(req("/settings", cookie));
      expect(res.headers.get("location")).toMatch(/\/signin\?next=%2Fsettings$/);
      expect(cleared(res)).toBe(true);
    }
  });

  it("answers 404 JSON for the routes the demo doesn't have, signed in or not, before any route code", async () => {
    const cookie = signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY);
    const gone = [
      "/api/ping/hb_0123456789abcdef0123456789abcdef", "/api/runner/poll", "/api/runner/jobs/x/report", "/api/v1", "/api/v1/status",
      "/api/v1/ai/chat/completions", "/api/v1/mcp", "/api/telegram/webhook", "/api/collect", "/api/daily", "/api/watchdog",
      "/auth/confirm", "/auth/google/callback", "/auth/google/create/callback", "/setup",
    ];
    for (const path of gone) {
      for (const res of [await proxy(req(path)), await proxy(req(path, cookie))]) {
        expect(res.status, path).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
        expect(res.headers.get("x-middleware-next")).toBeNull();
      }
    }
  });

  it("without a visitor: the status page is 404, other API routes 401 JSON (never a redirect), /api/health open", async () => {
    for (const path of ["/s/acme", "/s/acme/badge/uptime.svg"]) expect((await proxy(req(path))).status, path).toBe(404);
    for (const path of ["/api/status", "/api/office/state", "/api/office/proposals/x/decide", "/api/v1/openapi.json", "/api/anything"]) {
      const res = await proxy(req(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
    // A cookie that doesn't verify is no visitor either (and is cleared by the gate's response only; the 401 sets nothing).
    expect((await proxy(req("/api/office/state", "junk"))).status).toBe(401);
    expect((await proxy(req("/api/health"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("with a visitor: the status page, the office and openapi.json go through to their routes", async () => {
    const cookie = signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY);
    for (const path of ["/s/acme", "/api/office/state", "/api/office/proposals/x/decide", "/api/status", "/api/v1/openapi.json", "/api/health", "/auth/session-ended"]) {
      expect((await proxy(req(path, cookie))).headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("the demo proxy is a cookie check only: it imports no database schema, seed or pool", () => {
    const source = readFileSync("src/lib/demo/proxy.ts", "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["next/server", "@/lib/env", "./cookie"]);
  });

  it("never asks Supabase or the self-host session table", async () => {
    await proxy(req("/settings", signDemoCookie({ email: "ana@visitor.test", seed: SEED }, KEY)));
    await proxy(req("/settings", "junk"));
    expect(h.updateSession).not.toHaveBeenCalled();
    expect(h.updateSessionLocal).not.toHaveBeenCalled();
  });
});
