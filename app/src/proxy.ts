import { type NextRequest, NextResponse } from "next/server";
import { mode } from "@/lib/mode";
import { isPublicPath } from "@/lib/paths";
import { CSP_HEADER, cspHeader, isPrerenderedPath, newNonce, themeScriptHash } from "@/lib/security/csp";
import { STATIC_HTML_PATHS } from "@/lib/security/static-html";
import { updateSession } from "@/lib/supabase/proxy";

function redirectKeepingCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  // @supabase/ssr marks responses that carry session cookies as uncacheable.
  for (const name of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(name);
    if (value) redirect.headers.set(name, value);
  }
  return redirect;
}

// The sign-in gate every mode shares: a signed-out visitor goes to sign in (except on public paths), a signed-in one
// away from the sign-in page.
function gate(request: NextRequest, response: NextResponse, signedIn: boolean) {
  const { pathname, search } = request.nextUrl;
  if (!signedIn && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return redirectKeepingCookies(url, response);
  }
  if (signedIn && pathname === "/signin") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return redirectKeepingCookies(url, response);
  }
  return response;
}

// Watchbell 1.2.1: a per-request nonce and the enforced Content-Security-Policy (lib/security/csp.ts). The
// policy goes on the request too, where Next reads the nonce for its own scripts (request headers never reach the
// browser), and on every response this proxy returns, the early-returning paths included.
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const nonce = isPrerenderedPath(path) ? null : newNonce();
  const policy = cspHeader({ nonce, themeHash: await themeScriptHash(), dev: process.env.NODE_ENV === "development", staticFile: STATIC_HTML_PATHS.includes(path) });
  request.headers.set("content-security-policy", policy);
  if (nonce) request.headers.set("x-nonce", nonce);
  const response = await route(request);
  response.headers.set(CSP_HEADER, policy);
  return response;
}

async function route(request: NextRequest) {
  const m = mode();
  // Demo checks its own signed wp_demo cookie (no database, never Supabase), and answers the routes it doesn't have
  // (404) or that need a visitor (401) before the gate. Loaded only there, so cloud and self-host never import it.
  if (m === "demo") {
    const demo = await import("@/lib/demo/proxy");
    const { response, signedIn } = demo.updateSessionDemo(request);
    return demo.demoRouteRule(request.nextUrl.pathname, signedIn) ?? gate(request, response, signedIn);
  }
  // U3: the ping endpoint authenticates by its token alone; no session cookie is read or refreshed for it, so a ping
  // (or a flood of them carrying junk cookies) never turns into Supabase Auth work or a Set-Cookie.
  // 5c (R2): /api/v1/ authenticates by console API key alone, so it gets the same treatment: no cookie work, no Set-Cookie.
  // U6: the public status page (/s/) is the same: no session work, so it stays cacheable and a crawler costs no Auth call.
  // Stage 9 slice 7: the Telegram webhook authenticates by its secret header alone, same treatment.
  // Stage 9 slice 4: /api/runner/ authenticates by the VM runner's own token alone, same treatment.
  const path = request.nextUrl.pathname;
  if (path.startsWith("/api/ping/") || path.startsWith("/api/v1/") || path.startsWith("/api/runner/") || path.startsWith("/s/") || path === "/api/telegram/webhook") return NextResponse.next({ request });
  // Self-host keeps its sessions in its own database (wp_session cookie); loaded only there, so cloud never imports it.
  const { response, userId } = m === "selfhost" ? await (await import("@/lib/local-auth/proxy")).updateSessionLocal(request) : await updateSession(request);
  return gate(request, response, !!userId);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
