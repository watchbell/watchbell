import { type NextRequest, NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";
import { clearDemoCookie, DEMO_COOKIE, demoCookieKey, verifyDemoCookie } from "./cookie";

// The demo counterpart of src/lib/supabase/proxy.ts updateSession: a cookie check only (no database, no network, no
// schema import). A cookie that doesn't verify (tampered, expired, another server's key) is cleared.
export function updateSessionDemo(request: NextRequest): { response: NextResponse; signedIn: boolean } {
  const response = NextResponse.next({ request });
  const raw = request.cookies.get(DEMO_COOKIE)?.value;
  if (!raw) return { response, signedIn: false };
  const signedIn = verifyDemoCookie(raw, demoCookieKey(serverEnv().OPS_ENCRYPTION_KEY)) !== null;
  if (!signedIn) clearDemoCookie(response.cookies);
  return { response, signedIn };
}

// Routes the demo doesn't have: machine endpoints that authenticate by a token, key or secret of their own (pings, the
// VM runner, the public API, schedulers, the Telegram webhook), Supabase and Google sign-in callbacks, and self-host's
// first-run setup. They answer 404 before any route code runs. /api/v1/openapi.json stays: the signed-in visitor's API
// docs page downloads it, and it reads nothing but the session.
const GONE_PREFIX = ["/api/ping/", "/api/runner/", "/api/v1/", "/auth/google/"];
const GONE_EXACT = new Set(["/api/v1", "/api/telegram/webhook", "/api/collect", "/api/daily", "/api/watchdog", "/auth/confirm", "/setup"]);
const KEPT = new Set(["/api/v1/openapi.json"]);

const json = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// What the demo answers before the usual sign-in gate, or null to go on to it. Without a visitor cookie the public
// status page is 404 too (it shows a visitor's own made-up data), and every other API route is 401 JSON (never a
// redirect to the sign-in page); /api/health stays open.
export function demoRouteRule(pathname: string, signedIn: boolean): NextResponse | null {
  if (!KEPT.has(pathname) && (GONE_EXACT.has(pathname) || GONE_PREFIX.some((p) => pathname.startsWith(p)))) return json(404, "Not found");
  if (signedIn || pathname === "/api/health") return null;
  if (pathname.startsWith("/s/")) return json(404, "Not found");
  if (pathname.startsWith("/api/")) return json(401, "Unauthorized");
  return null;
}
