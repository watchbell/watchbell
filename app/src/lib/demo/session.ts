import "server-only";
import { cookies, headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";
import { serverEnv } from "@/lib/env";
import { DEMO_COOKIE, demoCookieKey, type DemoVisitor, verifyDemoCookie } from "./cookie";
import { demoClientKey, SHARED_CLIENT } from "./visitor-limits";

// Who the current demo visitor is: the signed wp_demo cookie (./cookie), verified once per server render (cache()).
// Outside a render (Server Actions, Route Handlers) cache() doesn't memoize and each call verifies again; an HMAC
// over a short string is cheap. The pool and facade call this on every query, so nothing per-visitor is kept here.
export { DEMO_COOKIE, type DemoVisitor };

// The key this server signs and verifies wp_demo with: the demo sub-key of OPS_ENCRYPTION_KEY (./cookie).
export const serverDemoCookieKey = (): Buffer => demoCookieKey(serverEnv().OPS_ENCRYPTION_KEY);

let testResolver: (() => Promise<DemoVisitor>) | undefined;

// Tests only (refused outside vitest): resolve the visitor without a request, e.g. from an AsyncLocalStorage that
// stands in for "the current request". Pass undefined to go back to the cookie.
export function setDemoVisitorResolverForTests(resolver: (() => Promise<DemoVisitor>) | undefined): void {
  if (!process.env.VITEST) throw new Error("setDemoVisitorResolverForTests is for tests only");
  testResolver = resolver;
}

// Null when signed out: no cookie, or one that is tampered with, expired or not signed by this server.
export const readDemoVisitor = cache(async (): Promise<DemoVisitor | null> => {
  if (testResolver) return testResolver();
  return verifyDemoCookie((await cookies()).get(DEMO_COOKIE)?.value, serverDemoCookieKey());
});

export async function currentDemoVisitor(): Promise<DemoVisitor> {
  const visitor = await readDemoVisitor();
  if (!visitor) throw new Error("Not signed in to the demo");
  return visitor;
}

export async function currentDemoSeed(): Promise<string> {
  return (await currentDemoVisitor()).seed;
}

export async function currentDemoEmail(): Promise<string> {
  return (await currentDemoVisitor()).email;
}

// The current request's client for the per-client limits (./visitor-limits). Outside a request (a script, a test) the
// shared bucket; Next.js's own signals (a prerender bailing out to dynamic) still propagate.
export async function currentDemoClientKey(): Promise<string> {
  try {
    return demoClientKey(await headers());
  } catch (e) {
    unstable_rethrow(e);
    return SHARED_CLIENT;
  }
}
