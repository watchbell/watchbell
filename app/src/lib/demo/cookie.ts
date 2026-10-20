import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionCookieOptions, type SessionCookieOptions } from "@/lib/local-auth/session-cookie";

// The demo's stateless sign-in: the wp_demo cookie says who the visitor is and which made-up dataset is theirs.
// Value: base64url(JSON { email, seed, iat }) + "." + base64url(HMAC-SHA256 of that first part, keyed with
// demoCookieKey(OPS_ENCRYPTION_KEY)). A changed email, seed or iat, a bad MAC, or an iat older than 7 days reads as
// signed out. No next/headers here: the proxy and the server pages (./session) both verify with it.
export const DEMO_COOKIE = "wp_demo";
export const DEMO_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
// A cookie from a server whose clock runs a little ahead is still fine; one from the far future is not.
const CLOCK_SKEW_S = 5 * 60;
export const MAX_DEMO_EMAIL = 254;

export type DemoVisitor = { seed: string; email: string };
type Payload = DemoVisitor & { iat: number };

const SEED = /^[0-9a-f]{32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

// Every sign-in gets a dataset of its own, the published account's too (ruling F): 16 random bytes, never derived from
// the email, so two visitors never share one writable dataset.
export function newDemoSeed(): string {
  return randomBytes(16).toString("hex");
}

// The MAC key: a sub-key of OPS_ENCRYPTION_KEY (base64) for this one purpose, so the raw key never signs anything a
// visitor holds. ./session (sign-in, server pages) and ./proxy both derive it here.
export function demoCookieKey(opsEncryptionKeyB64: string): Buffer {
  return createHmac("sha256", Buffer.from(opsEncryptionKeyB64, "base64")).update("watchpost:demo-cookie:v1").digest();
}

const mac = (payload: string, key: Buffer) => createHmac("sha256", key).update(payload).digest();

export function signDemoCookie(visitor: DemoVisitor, key: Buffer, now: number = Date.now()): string {
  const body: Payload = { email: visitor.email, seed: visitor.seed, iat: Math.floor(now / 1000) };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, key).toString("base64url")}`;
}

// The visitor the cookie names, or null for anything that isn't a cookie this server signed in the last 7 days.
export function verifyDemoCookie(raw: string | undefined, key: Buffer, now: number = Date.now()): DemoVisitor | null {
  if (!raw || raw.length > 1024) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) return null;
  const [payload, presented] = parts;
  const given = Buffer.from(presented, "base64url");
  const expected = mac(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: Partial<Payload>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    return null;
  }
  const { email, seed, iat } = body ?? {};
  if (typeof email !== "string" || !email || email.length > MAX_DEMO_EMAIL || email !== email.toLowerCase()) return null;
  if (typeof seed !== "string" || !SEED.test(seed)) return null;
  if (typeof iat !== "number" || !Number.isInteger(iat)) return null;
  const nowS = Math.floor(now / 1000);
  if (iat > nowS + CLOCK_SKEW_S || nowS - iat > DEMO_COOKIE_MAX_AGE_S) return null;
  return { email, seed };
}

// NextResponse.cookies and next/headers cookies() both fit.
type CookieJar = { set(name: string, value: string, options: SessionCookieOptions): unknown };

// httpOnly, sameSite lax, secure when SITE_URL is https, path / (the self-host session cookie's flags), 7 days.
export function demoCookieOptions(siteUrl: string | undefined = process.env.SITE_URL): SessionCookieOptions {
  return { ...sessionCookieOptions(siteUrl), maxAge: DEMO_COOKIE_MAX_AGE_S };
}

export function setDemoCookie(jar: CookieJar, value: string, siteUrl?: string): void {
  jar.set(DEMO_COOKIE, value, demoCookieOptions(siteUrl));
}

export function clearDemoCookie(jar: CookieJar, siteUrl?: string): void {
  jar.set(DEMO_COOKIE, "", { ...demoCookieOptions(siteUrl), maxAge: 0 });
}
