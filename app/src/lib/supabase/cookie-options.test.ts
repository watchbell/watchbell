import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ seen: [] as { cookieOptions?: unknown }[] }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, o: { cookieOptions?: unknown }) => {
    h.seen.push(o);
    return { auth: { getClaims: async () => ({ data: null }) } };
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
import { NextRequest } from "next/server";
import { supabaseCookieOptions } from "./cookie-options";
import { updateSession } from "./proxy";
import { createClient } from "./server";

// Watchbell 1.2.1 (audit L3): JavaScript in the page can't read the Supabase session cookies.
describe("Supabase cookie options", () => {
  it("are HttpOnly and SameSite=Lax; Secure in production", () => {
    expect(supabaseCookieOptions({ NODE_ENV: "production" })).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(supabaseCookieOptions({ NODE_ENV: "development" }).secure).toBe(false);
  });
  it("both server clients (pages and actions, and the proxy) use them", async () => {
    await createClient();
    await updateSession(new NextRequest("https://ops.example.com/"));
    expect(h.seen).toHaveLength(2);
    for (const o of h.seen) expect(o.cookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax" });
  });
});
