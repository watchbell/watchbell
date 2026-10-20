import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, members, rateLimits } from "@/db/schema";
import { type Limit, LIMITS, subjectKey, windowStart } from "@/lib/rate-limit";
import { hashPassword } from "./password";
import { hashToken } from "./session-token";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("./password", async (importOriginal) => {
  const real = await importOriginal<typeof import("./password")>();
  return { ...real, dummyVerify: vi.fn(real.dummyVerify), verifyPassword: vi.fn(real.verifyPassword) };
});

import { dummyVerify, TEMP_PASSWORD_EXPIRED, verifyPassword } from "./password";
import { createLocalSession } from "./sessions-db";
import { passwordSignIn, WRONG } from "./signin";

const PASSWORD = "correct horse battery";
// The clock is pinned mid-window (rate-limit windows are 15 min, aligned to :00/:15/:30/:45), so counters a test seeds
// and the hits it makes always land in the same window, however long the scrypt checks take.
const NOW = new Date("2026-10-19T10:07:30Z");
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let storedHash: string;
let userId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  storedHash = await hashPassword(PASSWORD);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.clearAllMocks();
  await db.execute(sql`delete from ops.local_users`);
  await db.execute(sql`delete from ops.members`);
  await db.execute(sql`delete from ops.rate_limits`);
  [{ id: userId }] = await db.insert(localUsers).values({ email: "ana@example.com", passwordHash: storedHash }).returning({ id: localUsers.id });
});

afterEach(() => {
  vi.useRealTimers();
});

const attempt = (over: Partial<Parameters<typeof passwordSignIn>[0]> = {}) =>
  passwordSignIn({ email: "ana@example.com", password: PASSWORD, ip: "203.0.113.5", userAgent: "test", presentedToken: undefined, ...over });

const addMember = (role: "owner" | "operator" | "viewer") => db.insert(members).values({ userId, email: "ana@example.com", role });
const count = async (l: Limit, subject: string) =>
  (await db.select({ n: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, subjectKey(l, subject))))[0]?.n ?? 0;
// Every counter a sign-in for ana@example.com from `ip` touches.
const counts = async (ip: string) => ({
  emailIp: await count(LIMITS.passwordEmailIp, `ana@example.com ${ip}`),
  email: await count(LIMITS.passwordEmail, "ana@example.com"),
  ip: await count(LIMITS.passwordIp, ip),
  all: await count(LIMITS.passwordFailuresAll, "all"),
});
const sessions = () => db.select().from(localSessions).where(eq(localSessions.userId, userId));

describe("password sign-in (self-host)", () => {
  it("signs in with the right password: a new aal1 session, stored hashed", async () => {
    await addMember("viewer");
    const r = await attempt({ email: "  Ana@Example.com " });
    expect(r).toMatchObject({ ok: true, redirectTo: "/" });
    if (!r.ok) throw new Error("expected ok");
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aal: "aal1", tokenHash: hashToken(r.token), userAgent: "test" });
  });

  it("gives the same generic answer for a wrong password and an unknown email, and burns a dummy check for the latter", async () => {
    const wrong = await attempt({ password: "not the password" });
    const unknown = await attempt({ email: "nobody@example.com" });
    expect(wrong).toEqual({ ok: false, message: WRONG });
    expect(unknown).toEqual({ ok: false, message: WRONG });
    expect(WRONG).toBe("Email or password is wrong.");
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(dummyVerify).toHaveBeenCalledTimes(1);
    expect(await sessions()).toHaveLength(0);
  });

  it("refuses blank or oversized input with the same answer and no session", async () => {
    expect(await attempt({ password: "" })).toEqual({ ok: false, message: WRONG });
    expect(await attempt({ email: "" })).toEqual({ ok: false, message: WRONG });
    expect(await attempt({ password: "x".repeat(2000) })).toEqual({ ok: false, message: WRONG });
    expect(await sessions()).toHaveLength(0);
  });

  it("locks an email from a known IP after 10 wrong passwords in 15 minutes, even for the right password then", async () => {
    for (let i = 0; i < 10; i++) expect(await attempt({ password: `wrong ${i}`, ip: "198.51.100.7" })).toEqual({ ok: false, message: WRONG });
    expect(await counts("198.51.100.7")).toEqual({ emailIp: 10, email: 10, ip: 10, all: 10 });
    const locked = await attempt({ ip: "198.51.100.7" });
    expect(locked.ok).toBe(false);
    if (locked.ok) throw new Error("expected refusal");
    expect(locked.message).toMatch(/^Too many attempts\. Try again in \d+ min\.$/);
    expect(verifyPassword).toHaveBeenCalledTimes(10);
    expect(await sessions()).toHaveLength(0);
    // The refused attempt added to no counter.
    expect(await counts("198.51.100.7")).toEqual({ emailIp: 10, email: 10, ip: 10, all: 10 });
    // The same email from another address still gets in (a stranger can't lock the owner out from one IP).
    await addMember("viewer");
    expect(await attempt({ ip: "192.0.2.1" })).toMatchObject({ ok: true });
    expect(await counts("192.0.2.1")).toEqual({ emailIp: 0, email: 10, ip: 0, all: 10 });
  }, 60_000);

  it("without a trusted IP, locks an email after 50 wrong passwords (unknown emails alike)", async () => {
    for (let i = 0; i < 50; i++) await attempt({ email: "ghost@example.com", password: "x", ip: null });
    expect(await attempt({ email: "ghost@example.com", password: "x", ip: null })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await count(LIMITS.passwordEmail, "ghost@example.com")).toBe(50);
    for (let i = 0; i < 49; i++) await attempt({ password: `wrong ${i}`, ip: null });
    await addMember("viewer");
    expect(await attempt({ ip: null })).toMatchObject({ ok: true });
    expect(await count(LIMITS.passwordEmail, "ana@example.com")).toBe(49);
    await attempt({ password: "wrong again", ip: null });
    expect(await attempt({ ip: null })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await count(LIMITS.passwordEmail, "ana@example.com")).toBe(50);
  }, 120_000);

  it("a successful sign-in gives back exactly its email and email+IP hits, and never touches the IP count", async () => {
    await addMember("viewer");
    for (let i = 0; i < 3; i++) await attempt({ password: `wrong ${i}`, ip: "198.51.100.8" });
    expect(await counts("198.51.100.8")).toEqual({ emailIp: 3, email: 3, ip: 3, all: 3 });
    for (let i = 0; i < 3; i++) expect((await attempt({ ip: "198.51.100.8" })).ok).toBe(true);
    expect(await counts("198.51.100.8")).toEqual({ emailIp: 3, email: 3, ip: 3, all: 3 });
  }, 60_000);

  it("failures on other emails mixed with the attacker's own successes still reach the per-IP cap (30)", async () => {
    await addMember("viewer");
    for (let i = 0; i < 30; i++) {
      expect((await attempt({ email: `p${i}@example.com`, password: "x", ip: "203.0.113.9" })).ok).toBe(false);
      // The 30th failure fills the IP's budget, so that round's own sign-in is already refused.
      expect((await attempt({ ip: "203.0.113.9" })).ok).toBe(i < 29);
    }
    expect(await count(LIMITS.passwordIp, "203.0.113.9")).toBe(30);
    expect(await attempt({ ip: "203.0.113.9" })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await count(LIMITS.passwordIp, "203.0.113.9")).toBe(30);
    // Another address is unaffected.
    expect(await attempt({ ip: "203.0.113.10" })).toMatchObject({ ok: true });
  }, 120_000);

  it("many failures across everyone only log a warning, once per window, and refuse nobody", async () => {
    await addMember("viewer");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.insert(rateLimits).values({ key: subjectKey(LIMITS.passwordFailuresAll, "all"), windowStart: windowStart(NOW, 900), count: 299 });
    await attempt({ email: "x1@example.com", password: "x", ip: null });
    expect(warn).not.toHaveBeenCalled();
    await attempt({ email: "x2@example.com", password: "x", ip: null });
    await attempt({ email: "x3@example.com", password: "x", ip: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^many failed sign-ins; consider a trusted proxy \/ firewall/);
    expect(await attempt({ ip: null })).toMatchObject({ ok: true });
    warn.mockRestore();
  }, 60_000);

  it("ends the session the browser already presents before starting the new one", async () => {
    await addMember("viewer");
    const { token: old } = await createLocalSession(userId, { aal: "aal2" });
    const r = await attempt({ presentedToken: old });
    if (!r.ok) throw new Error("expected ok");
    const rows = await sessions();
    expect(rows.map((s) => s.tokenHash)).toEqual([hashToken(r.token)]);
  });

  it("sends owners and operators to the MFA step, and a forced password change after it", async () => {
    await addMember("owner");
    expect(await attempt()).toMatchObject({ ok: true, redirectTo: "/mfa/setup" });
    await db.update(localUsers).set({ totpConfirmedAt: new Date(), mustChangePassword: true }).where(eq(localUsers.id, userId));
    expect(await attempt()).toMatchObject({ ok: true, redirectTo: "/mfa" });
  });

  it("sends a viewer who must change the password straight to /account/password; otherwise to a safe next", async () => {
    await addMember("viewer");
    expect(await attempt({ next: "/settings?tab=users" })).toMatchObject({ redirectTo: "/settings?tab=users" });
    expect(await attempt({ next: "//evil.example" })).toMatchObject({ redirectTo: "/" });
    await db.update(localUsers).set({ mustChangePassword: true }).where(eq(localUsers.id, userId));
    expect(await attempt({ next: "/settings" })).toMatchObject({ ok: true, redirectTo: "/account/password" });
  });

  it("refuses an expired temporary password, saying so only after the right password, and gives the hits back", async () => {
    await addMember("viewer");
    await db
      .update(localUsers)
      .set({ mustChangePassword: true, tempPasswordExpiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(localUsers.id, userId));
    expect(await attempt({ password: "not the password", ip: "198.51.100.20" })).toEqual({ ok: false, message: WRONG });
    expect(await attempt({ ip: "198.51.100.20" })).toEqual({ ok: false, message: TEMP_PASSWORD_EXPIRED });
    expect(TEMP_PASSWORD_EXPIRED).toBe("This temporary password has expired. Ask an owner for a new one.");
    expect(await sessions()).toHaveLength(0);
    // Only the wrong guess counts.
    expect(await counts("198.51.100.20")).toEqual({ emailIp: 1, email: 1, ip: 1, all: 1 });
    // Still within its 7 days: in, straight to the password change.
    await db.update(localUsers).set({ tempPasswordExpiresAt: new Date(NOW.getTime() + 1) }).where(eq(localUsers.id, userId));
    expect(await attempt({ ip: "198.51.100.20" })).toMatchObject({ ok: true, redirectTo: "/account/password" });
  });

  it("a viewer with a confirmed factor must still enter its code", async () => {
    await addMember("viewer");
    await db.update(localUsers).set({ totpConfirmedAt: new Date() }).where(eq(localUsers.id, userId));
    expect(await attempt()).toMatchObject({ ok: true, redirectTo: "/mfa" });
  });
});
