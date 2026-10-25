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
import { BACKOFF, BACKOFF_NAMES, backoffKeys } from "@/lib/backoff";

const h = vi.hoisted(() => ({ db: undefined as unknown, alert: vi.fn(async () => {}) }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/data/auth-alert", () => ({ notifyAuthFailures: h.alert }));
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
const fails = async (name: string, subject: string) =>
  (await db.select({ n: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, backoffKeys(name, subject)[0])))[0]?.n ?? 0;
// Every counter a sign-in for ana@example.com from `ip` touches.
const counts = async (ip: string) => ({
  emailIp: await fails(BACKOFF_NAMES.accountIp, `ana@example.com ${ip}`),
  ip: await fails(BACKOFF_NAMES.ip, ip),
  all: await count(LIMITS.passwordFailuresAll, "all"),
});
const later = (s: number) => vi.setSystemTime(new Date(Date.now() + s * 1000));
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

  // Watchbell 1.2.1 (audit L5): exponential back-off instead of hard windows; another network never locks the owner out.
  it("backs off an email from one network after 5 wrong passwords, even for the right password; another network still gets in", async () => {
    for (let i = 0; i < BACKOFF.free; i++) expect(await attempt({ password: `wrong ${i}`, ip: "198.51.100.7" })).toEqual({ ok: false, message: WRONG });
    expect(await counts("198.51.100.7")).toEqual({ emailIp: 5, ip: 5, all: 5 });
    const locked = await attempt({ ip: "198.51.100.7" });
    expect(locked).toEqual({ ok: false, message: "Too many attempts. Try again in 1 min." });
    expect(verifyPassword).toHaveBeenCalledTimes(5);
    expect(await sessions()).toHaveLength(0);
    // The refused attempt added to no counter.
    expect(await counts("198.51.100.7")).toEqual({ emailIp: 5, ip: 5, all: 5 });
    await addMember("viewer");
    expect(await attempt({ ip: "192.0.2.1" })).toMatchObject({ ok: true });
  }, 60_000);

  // Review I1: parallel guesses can't all pass a stale back-off read.
  it("40 parallel wrong passwords from one network reach the password check at most the burst cap (10 per 15 minutes)", async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => attempt({ password: `wrong ${i}`, ip: "198.51.100.44" })));
    expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(LIMITS.passwordBurst.max);
  }, 120_000);

  // Review I2: many networks together are bounded per account; a network that signed in before isn't.
  it("50 wrong passwords from 50 networks back the account off for new networks; a network that signed in before still gets in", async () => {
    await addMember("viewer");
    expect(await attempt({ ip: "192.0.2.77" })).toMatchObject({ ok: true }); // the owner's own network
    for (let i = 0; i < 50; i++) await attempt({ password: "x", ip: `2001:db8:${i.toString(16)}::/64` });
    expect(await attempt({ ip: "203.0.113.200" })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await attempt({ ip: "192.0.2.77" })).toMatchObject({ ok: true });
  }, 180_000);

  // Review T2b-fix I-3: the network stays known past the 30-day session it signed in with.
  it("a network that signed in is still known when its 30-day session has run out", async () => {
    await addMember("viewer");
    expect(await attempt({ ip: "192.0.2.77" })).toMatchObject({ ok: true });
    later(30 * 86_400 + 60);
    for (let i = 0; i < 50; i++) await attempt({ password: "x", ip: `2001:db8:${i.toString(16)}::/64` });
    expect(await attempt({ ip: "203.0.113.200" })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await attempt({ ip: "192.0.2.77" })).toMatchObject({ ok: true });
  }, 180_000);

  it("the wait doubles after each further failure and ends on its own", async () => {
    await addMember("viewer");
    for (let i = 0; i < BACKOFF.free; i++) await attempt({ password: `wrong ${i}`, ip: "198.51.100.9" });
    later(31);
    expect(await attempt({ password: "wrong again", ip: "198.51.100.9" })).toEqual({ ok: false, message: WRONG });
    later(31);
    expect((await attempt({ ip: "198.51.100.9" })).ok).toBe(false); // 60 s now
    later(30);
    expect(await attempt({ ip: "198.51.100.9" })).toMatchObject({ ok: true });
    expect((await counts("198.51.100.9")).emailIp).toBe(0); // a success starts the account over on this network
  }, 60_000);

  it("without a trusted IP the email alone backs off (unknown emails alike), and a success starts it over", async () => {
    for (let i = 0; i < BACKOFF.free; i++) await attempt({ email: "ghost@example.com", password: "x", ip: null });
    expect(await attempt({ email: "ghost@example.com", password: "x", ip: null })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    await addMember("viewer");
    for (let i = 0; i < BACKOFF.free - 1; i++) await attempt({ password: `wrong ${i}`, ip: null });
    expect(await attempt({ ip: null })).toMatchObject({ ok: true });
    expect(await fails(BACKOFF_NAMES.account, "ana@example.com")).toBe(0);
  }, 120_000);

  it("failures on other emails back off the network itself; another address is unaffected", async () => {
    await addMember("viewer");
    for (let i = 0; i < BACKOFF.free; i++) expect((await attempt({ email: `p${i}@example.com`, password: "x", ip: "203.0.113.9" })).ok).toBe(false);
    expect(await attempt({ ip: "203.0.113.9" })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too many attempts/) });
    expect(await attempt({ ip: "203.0.113.10" })).toMatchObject({ ok: true });
  }, 60_000);

  it("10 wrong passwords for an account in a day (from any network) send the Telegram alert", async () => {
    for (let i = 0; i < 9; i++) await attempt({ password: "x", ip: `198.51.100.${i + 30}` });
    expect(h.alert).not.toHaveBeenCalled();
    await attempt({ password: "x", ip: "198.51.100.99" });
    expect(h.alert).toHaveBeenCalledWith("password", "ana@example.com", 10);
    await attempt({ email: "nobody@example.com", password: "x", ip: "198.51.100.98" });
    expect(h.alert).toHaveBeenCalledTimes(1); // unknown emails never alert
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
    // Only the wrong guess counts (the right one started the account over on this network).
    expect(await counts("198.51.100.20")).toEqual({ emailIp: 0, ip: 1, all: 1 });
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
