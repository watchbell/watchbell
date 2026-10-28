import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localUsers, members } from "@/db/schema";
import { hashPassword } from "@/lib/local-auth/password";

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  jar: new Map<string, { value: string; options?: unknown }>(),
  forwardedFor: "198.51.100.7",
}));
vi.mock("@/db/client", () => ({ db: () => h.db }));
const DEMO_KEY_B64 = Buffer.alloc(32, 1).toString("base64");
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "http://127.0.0.1:3100", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key", OPS_ENCRYPTION_KEY: DEMO_KEY_B64 }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.2.2.2", "x-forwarded-for": h.forwardedFor, "user-agent": "test-browser" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => void h.jar.set(name, { value, options }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {} }) }));

import { PUBLISHED_DEMO_EMAIL, PUBLISHED_DEMO_PASSWORD } from "@/lib/demo/account";
import { demoCookieKey, verifyDemoCookie } from "@/lib/demo/cookie";
import { DEMO_SIGN_IN_LIMITED, resetDemoLimitsForTests, SIGN_INS_PER_CLIENT, SIGN_INS_SHARED } from "@/lib/demo/visitor-limits";
import { readLocalSession } from "@/lib/local-auth/sessions-db";
import { sendSignInLink, signInWithPassword } from "./actions";
import { DemoSignInForm } from "./demo-form";
import SignInPage from "./page";
import { PasswordSignInForm } from "./password-form";
import { SignInForm } from "./signin-form";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  const [{ id }] = await db
    .insert(localUsers)
    .values({ email: "ana@example.com", passwordHash: await hashPassword("a long enough password") })
    .returning({ id: localUsers.id });
  await db.insert(members).values({ userId: id, email: "ana@example.com", role: "viewer" });
}, 120_000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  h.jar.clear();
  h.forwardedFor = "198.51.100.7";
  resetDemoLimitsForTests();
  await db.execute(sql`delete from ops.rate_limits`);
  await db.execute(sql`delete from ops.local_sessions`);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// The form component the page renders (searches the returned element tree).
function formType(node: ReactNode): unknown {
  if (!isValidElement(node)) return Array.isArray(node) ? node.map(formType).find(Boolean) : undefined;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === PasswordSignInForm || el.type === SignInForm || el.type === DemoSignInForm) return el.type;
  return formType(el.props.children);
}

describe("signInWithPassword", () => {
  it("self-host: the right password sets the session cookie and redirects", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    await expect(signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "a long enough password", next: "/alerts" }))).rejects.toThrow(/^REDIRECT \/alerts$/);
    const cookie = h.jar.get("wp_session")!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    expect(await readLocalSession(cookie.value)).toMatchObject({ email: "ana@example.com", aal: "aal1" });
  });

  it("self-host: a wrong password answers generically, keeps the email and sets no cookie", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(await signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "wrong password!" }))).toEqual({
      status: "error",
      message: "Email or password is wrong.",
      email: "ana@example.com",
    });
    expect(h.jar.size).toBe(0);
  });

  it("cloud: refuses without touching local users or cookies, echoing at most 254 characters", async () => {
    const r = await signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "a long enough password" }));
    expect(r).toMatchObject({ status: "error", email: "ana@example.com" });
    const long = await signInWithPassword({ status: "idle" }, form({ email: "a".repeat(5000), password: "x" }));
    expect(long.status === "error" && long.email.length).toBe(254);
    expect(h.jar.size).toBe(0);
    expect((await db.execute(sql`select count(*)::int as n from ops.local_sessions`)).rows).toEqual([{ n: 0 }]);
  });
});

describe("sign-in in demo", () => {
  beforeEach(() => vi.stubEnv("WATCHPOST_MODE", "demo"));
  const demoKey = demoCookieKey(DEMO_KEY_B64);
  const counts = async () => ({
    limits: (await db.execute(sql`select count(*)::int as n from ops.rate_limits`)).rows,
    sessions: (await db.execute(sql`select count(*)::int as n from ops.local_sessions`)).rows,
  });

  it("the published account: a signed wp_demo cookie with a new random seed, then where the visitor was heading", async () => {
    await expect(signInWithPassword({ status: "idle" }, form({ email: PUBLISHED_DEMO_EMAIL, password: PUBLISHED_DEMO_PASSWORD, next: "/alerts" }))).rejects.toThrow(/^REDIRECT \/alerts$/);
    const cookie = h.jar.get("wp_demo")!;
    expect(cookie.options).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 7 * 24 * 60 * 60 });
    const first = verifyDemoCookie(cookie.value, demoKey);
    expect(first).toEqual({ email: PUBLISHED_DEMO_EMAIL, seed: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // No accounts table, limiter or session row: the cookie is the whole session.
    expect(await counts()).toEqual({ limits: [{ n: 0 }], sessions: [{ n: 0 }] });
    expect(h.jar.has("wp_session")).toBe(false);
    // Ruling F: the same account again is a dataset of its own.
    await expect(signInWithPassword({ status: "idle" }, form({ email: PUBLISHED_DEMO_EMAIL, password: PUBLISHED_DEMO_PASSWORD }))).rejects.toThrow(/^REDIRECT \/overview$/);
    expect(verifyDemoCookie(h.jar.get("wp_demo")!.value, demoKey)?.seed).not.toBe(first?.seed);
  });

  it("any other email and password: their own random seed, new on every sign-in", async () => {
    await expect(signInWithPassword({ status: "idle" }, form({ email: "Ana@Example.com", password: "x" }))).rejects.toThrow(/^REDIRECT \/overview$/);
    const first = verifyDemoCookie(h.jar.get("wp_demo")!.value, demoKey);
    await expect(signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "y" }))).rejects.toThrow(/^REDIRECT \/overview$/);
    const second = verifyDemoCookie(h.jar.get("wp_demo")!.value, demoKey);
    expect(first?.email).toBe("ana@example.com");
    expect(second?.email).toBe("ana@example.com");
    expect(first?.seed).not.toBe(second?.seed);
  });

  it("limits sign-ins per client: on Vercel per left-most x-forwarded-for address, elsewhere one shared bucket", async () => {
    const signIn = () => signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "x" })).catch((e: Error) => e.message);
    vi.stubEnv("VERCEL", "1");
    h.forwardedFor = "198.51.100.7, 10.0.0.1";
    for (let i = 0; i < SIGN_INS_PER_CLIENT; i++) expect(await signIn()).toBe("REDIRECT /overview");
    h.jar.clear();
    expect(await signIn()).toEqual({ status: "error", message: DEMO_SIGN_IN_LIMITED, email: "ana@example.com" });
    expect(h.jar.size).toBe(0);
    h.forwardedFor = "203.0.113.9"; // another client is not affected
    expect(await signIn()).toBe("REDIRECT /overview");

    vi.stubEnv("VERCEL", "");
    resetDemoLimitsForTests();
    for (let i = 0; i < SIGN_INS_SHARED; i++) expect(await signIn()).toBe("REDIRECT /overview");
    h.forwardedFor = "192.0.2.1"; // a header outside Vercel is never trusted: still the shared bucket
    expect(await signIn()).toMatchObject({ status: "error", message: DEMO_SIGN_IN_LIMITED });
  });

  it("an invalid email is reported against the email field, a bad password against the password field", async () => {
    expect(await signInWithPassword({ status: "idle" }, form({ email: "nope", password: "x" }))).toMatchObject({ field: "email" });
    expect(await signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "" }))).toMatchObject({ field: "password" });
  });

  it("refuses an invalid email or an empty / over-long password, keeping the email and setting no cookie", async () => {
    expect(await signInWithPassword({ status: "idle" }, form({ email: "nope", password: "x" }))).toEqual({ status: "error", message: "Enter a valid email address.", email: "nope", field: "email" });
    expect(await signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "" }))).toMatchObject({ status: "error", email: "ana@example.com" });
    expect(await signInWithPassword({ status: "idle" }, form({ email: "ana@example.com", password: "p".repeat(201) }))).toMatchObject({ status: "error" });
    // 255 characters: refused whole, never cut down to a valid 254-character address.
    const long = await signInWithPassword({ status: "idle" }, form({ email: `${"a".repeat(250)}@x.io`, password: "x" }));
    expect(long).toMatchObject({ status: "error", message: "Enter a valid email address." });
    expect(long.status === "error" && long.email.length).toBe(254);
    expect(h.jar.size).toBe(0);
  });

  it("still refuses the email link (never Supabase)", async () => {
    expect(await sendSignInLink({ status: "idle" }, form({ email: "ana@example.com" }))).toMatchObject({ status: "error" });
    expect(h.jar.size).toBe(0);
    expect(await counts()).toEqual({ limits: [{ n: 0 }], sessions: [{ n: 0 }] });
  });
});

describe("sendSignInLink", () => {
  it("self-host: refused before any Supabase or limiter work", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(await sendSignInLink({ status: "idle" }, form({ email: "ana@example.com" }))).toMatchObject({ status: "error" });
    expect((await db.execute(sql`select count(*)::int as n from ops.rate_limits`)).rows).toEqual([{ n: 0 }]);
  });
});

describe("sign-in page", () => {
  it("cloud renders the magic-link form, self-host the password form", async () => {
    expect(formType(await SignInPage({ searchParams: Promise.resolve({}) }))).toBe(SignInForm);
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(formType(await SignInPage({ searchParams: Promise.resolve({ next: "/x" }) }))).toBe(PasswordSignInForm);
  });

  it("demo renders its own form with the published account (never the Supabase magic-link form)", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    expect(formType(await SignInPage({ searchParams: Promise.resolve({}) }))).toBe(DemoSignInForm);
  });

  it("the demo form shows the published account, a button that fills it in, and the any-email line", () => {
    const out = renderToStaticMarkup(createElement(DemoSignInForm, { next: "/alerts" }));
    expect(out).toContain(PUBLISHED_DEMO_EMAIL);
    expect(out).toContain(PUBLISHED_DEMO_PASSWORD);
    expect(out).toMatch(/<button type="button"[^>]*>Use demo account<\/button>/);
    expect(out).toContain("Or use any email and password. Every sign-in, the demo account too, gets its own made-up data.");
    expect(out).toContain('name="next" value="/alerts"');
    expect(out).toContain('maxLength="200"');
  });
});
