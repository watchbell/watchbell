import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Sign-in to console gate, end to end in demo: the signed cookie, the auth provider, the real pool and the real seed.
// The visitor's own database must hold them as its owner, under the email they signed in with.
const KEY_B64 = Buffer.alloc(32, 11).toString("base64");
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
  }),
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64, SITE_URL: "http://127.0.0.1:3100" }) }));

import { findMember, requireActionMember } from "@/lib/auth";
import { authProvider } from "@/lib/auth-provider";
import { PUBLISHED_DEMO_EMAIL } from "./account";
import { demoCookieKey } from "./cookie";
import { closeDemoPool } from "./pool";
import { demoSignIn } from "./signin";

const KEY = demoCookieKey(KEY_B64);

beforeAll(async () => {
  vi.stubEnv("WATCHPOST_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "");
  await (await import("@/db/client")).ready();
});
afterAll(async () => {
  await closeDemoPool();
  vi.unstubAllEnvs();
});

async function signIn(email: string) {
  const r = demoSignIn({ email, password: "any password" }, KEY);
  if (!r.ok) throw new Error(r.message);
  jar.set("wp_demo", r.cookie);
  const user = await authProvider().sessionUser();
  if (!user) throw new Error("not signed in");
  return user;
}

describe("demo sign-in → console", () => {
  it("the visitor is the owner of their seeded database, under the cookie's email; every sign-in is a new dataset", async () => {
    const first = await signIn(PUBLISHED_DEMO_EMAIL);
    expect(first).toMatchObject({ email: PUBLISHED_DEMO_EMAIL, aal: "aal2" });
    expect(await findMember(first.userId)).toMatchObject({ userId: first.userId, email: PUBLISHED_DEMO_EMAIL, role: "owner" });
    await expect(requireActionMember("owner")).resolves.toMatchObject({ email: PUBLISHED_DEMO_EMAIL, role: "owner" });

    // Ruling F: signing in to the published account again is a dataset of its own, and the first one isn't in it.
    const again = await signIn(PUBLISHED_DEMO_EMAIL);
    expect(again.userId).not.toBe(first.userId);
    expect(await findMember(again.userId)).toMatchObject({ email: PUBLISHED_DEMO_EMAIL, role: "owner" });
    expect(await findMember(first.userId)).toBeNull();

    const other = await signIn("Ana@Visitor.test");
    expect(other.email).toBe("ana@visitor.test");
    expect(other.userId).not.toBe(first.userId);
    expect(await findMember(other.userId)).toMatchObject({ email: "ana@visitor.test", role: "owner" });
    // Each visitor sees only their own database: the published account's member isn't in this one.
    expect(await findMember(first.userId)).toBeNull();
  }, 60_000);
});
