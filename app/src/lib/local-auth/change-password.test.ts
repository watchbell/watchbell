import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, rateLimits } from "@/db/schema";
import { LIMITS, subjectKey } from "@/lib/rate-limit";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("./password", async (importOriginal) => {
  const real = await importOriginal<typeof import("./password")>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword) };
});

import { changeLocalPassword } from "./change-password";
import { hashPassword, TEMP_PASSWORD_EXPIRED, verifyPassword } from "./password";
import { createLocalSession, readLocalSession } from "./sessions-db";

const OLD = "temporary-password-1";
const NEW = "my own password 42";
// Pinned mid-window, so every attempt of a test lands in the same 15-minute rate-limit window.
const NOW = new Date("2026-10-19T10:07:30Z");
const DAY = 24 * 60 * 60 * 1000;
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let oldHash: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  oldHash = await hashPassword(OLD);
}, 120_000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.mocked(verifyPassword).mockClear();
  await db.execute(sql`delete from ops.local_users`);
  await db.execute(sql`delete from ops.rate_limits`);
  [{ id: userId }] = await db
    .insert(localUsers)
    .values({ email: "ana@example.com", passwordHash: oldHash, mustChangePassword: true, tempPasswordExpiresAt: new Date(NOW.getTime() + 7 * DAY) })
    .returning({ id: localUsers.id });
  [{ id: otherUserId }] = await db.insert(localUsers).values({ email: "bo@example.com", passwordHash: oldHash }).returning({ id: localUsers.id });
});

afterEach(() => {
  vi.useRealTimers();
});

const change = (token: string, over: Partial<{ current: string; password: string; confirm: string }> = {}) =>
  changeLocalPassword({ token, current: OLD, password: NEW, confirm: NEW, userAgent: "test", ...over });
const user = async () => (await db.select().from(localUsers).where(eq(localUsers.id, userId)))[0];
const failures = async () =>
  (await db.select({ n: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, subjectKey(LIMITS.passwordChange, userId))))[0]?.n ?? 0;

describe("changeLocalPassword", () => {
  it("stores the new hash, clears must_change_password, rotates this session (same aal) and ends the others", async () => {
    const { token: current } = await createLocalSession(userId, { aal: "aal2" });
    const { token: otherDevice } = await createLocalSession(userId, { aal: "aal1" });
    const { token: someoneElse } = await createLocalSession(otherUserId, { aal: "aal1" });

    const r = await change(current);
    expect(r.status).toBe("ok");
    const fresh = r.status === "ok" ? r.token : "";
    expect(fresh).not.toBe(current);
    expect(await readLocalSession(fresh)).toMatchObject({ userId, aal: "aal2" });
    expect(await readLocalSession(current)).toBeNull();
    expect(await readLocalSession(otherDevice)).toBeNull();
    expect(await readLocalSession(someoneElse)).toMatchObject({ userId: otherUserId });
    expect(await db.select().from(localSessions).where(eq(localSessions.userId, userId))).toHaveLength(1);

    const row = await user();
    expect(row.mustChangePassword).toBe(false);
    expect(row.tempPasswordExpiresAt).toBeNull();
    expect(row.passwordHash).not.toContain(NEW);
    expect(await verifyPassword(NEW, row.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD, row.passwordHash)).toBe(false);
  });

  it("refuses a wrong current password, counts it per user, and locks after 5", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    for (let i = 0; i < 5; i++) {
      expect(await change(token, { current: "not the password" })).toEqual({ status: "error", message: "That isn't your current password.", field: "current" });
    }
    expect(await failures()).toBe(5);
    // Locked: even the right password is refused now, and the refusal adds nothing.
    const locked = await change(token);
    expect(locked).toMatchObject({ status: "error", field: "current" });
    expect(locked.status === "error" && locked.message).toMatch(/^Too many wrong passwords\. Try again in \d+ minutes?\.$/);
    expect(await failures()).toBe(5);
    expect((await user()).passwordHash).toBe(oldHash);
    expect(await readLocalSession(token)).toMatchObject({ userId });
  });

  it("parallel wrong guesses can't get past the limit: at most 5 are checked, the rest are refused and add nothing", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    const results = await Promise.all(Array.from({ length: 8 }, () => change(token, { current: "not the password" })));
    expect(results.filter((r) => r.status === "error" && r.message === "That isn't your current password.")).toHaveLength(5);
    expect(results.filter((r) => r.status === "error" && r.message.startsWith("Too many wrong passwords"))).toHaveLength(3);
    expect(verifyPassword).toHaveBeenCalledTimes(5);
    expect(await failures()).toBe(5);
  });

  it("a right current password gives its hit back", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    await change(token, { current: "not the password" });
    expect(await failures()).toBe(1);
    expect((await change(token)).status).toBe("ok");
    expect(await failures()).toBe(1);
  });

  it("refuses an expired temporary password (after checking it), and changes nothing", async () => {
    await db.update(localUsers).set({ tempPasswordExpiresAt: new Date(NOW.getTime() - 1) }).where(eq(localUsers.id, userId));
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    expect(await change(token, { current: "not the password" })).toMatchObject({ message: "That isn't your current password." });
    expect(await change(token)).toEqual({ status: "error", message: TEMP_PASSWORD_EXPIRED, field: "current" });
    expect(await failures()).toBe(1);
    expect((await user()).passwordHash).toBe(oldHash);
    expect((await user()).mustChangePassword).toBe(true);
  });

  it("checks the new password before the current one, and a rule problem costs no attempt", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    expect(await change(token, { current: "" })).toMatchObject({ status: "error", field: "current" });
    expect(await change(token, { password: "short", confirm: "short" })).toEqual({ status: "error", message: "Use at least 12 characters.", field: "password" });
    expect(await change(token, { confirm: "something else!!" })).toEqual({ status: "error", message: "The new passwords don't match.", field: "confirm" });
    expect(await change(token, { password: OLD, confirm: OLD })).toMatchObject({ status: "error", field: "password" });
    expect(await failures()).toBe(0);
    expect((await user()).mustChangePassword).toBe(true);
  });

  it("is signed out without a live session, and changes nothing", async () => {
    expect(await change("x".repeat(43))).toEqual({ status: "signed-out" });
    expect(await change("")).toEqual({ status: "signed-out" });
    expect((await user()).passwordHash).toBe(oldHash);
  });
});
