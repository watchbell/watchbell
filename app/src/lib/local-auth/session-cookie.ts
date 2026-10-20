// The self-host session cookie. It carries the raw token; the database keeps only its sha256 (sessions-db.ts).
export const SESSION_COOKIE = "wp_session";
const MAX_AGE_S = 30 * 24 * 60 * 60; // the absolute session lifetime

export type SessionCookieOptions = { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number };
// NextResponse.cookies and next/headers cookies() both fit.
type CookieJar = { set(name: string, value: string, options: SessionCookieOptions): unknown };

function isHttps(siteUrl: string | undefined): boolean {
  try {
    return new URL(siteUrl ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieOptions(siteUrl: string | undefined = process.env.SITE_URL): SessionCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: isHttps(siteUrl), path: "/", maxAge: MAX_AGE_S };
}

export function setSessionCookie(jar: CookieJar, token: string, siteUrl?: string): void {
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(siteUrl));
}

export function clearSessionCookie(jar: CookieJar, siteUrl?: string): void {
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(siteUrl), maxAge: 0 });
}
