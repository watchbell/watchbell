import { mode } from "./mode";

// The scheduler routes authenticate themselves (bearer secret or QStash signature). /api/health is a public liveness check.
// /api/telegram/webhook authenticates by Telegram's secret header (Stage 9 slice 7).
const PUBLIC_EXACT = new Set(["/signin", "/api/collect", "/api/watchdog", "/api/daily", "/api/health", "/api/telegram/webhook"]);
// The ping endpoint authenticates by its token (U3, B2). The public status page and its badges (/s/{slug}, U6/U7) are
// for anyone: they show only what the owner chose (B1). /api/v1/ (5c) authenticates by console API key only and never
// reads the session (R2). /api-docs is a console page.
const PUBLIC_PREFIX = ["/auth/", "/api/ping/", "/api/v1/", "/s/"];

// Self-host only: the first-run setup page (it refuses itself once an owner exists).
const SELFHOST_EXACT = new Set(["/setup"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIX.some((p) => pathname.startsWith(p)) || (SELFHOST_EXACT.has(pathname) && mode() === "selfhost");
}

// Only same-site, absolute paths survive. Anything that could leave the site falls back.
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const url = new URL(next, "http://console.local");
    if (url.origin !== "http://console.local") return fallback;
    // Dot segments are resolved by the parser ("/..//evil.com" becomes "//evil.com"), so check the output too.
    const out = url.pathname + url.search;
    if (out.startsWith("//") || out.startsWith("/\\")) return fallback;
    return out;
  } catch {
    return fallback;
  }
}
