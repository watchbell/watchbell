import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, rateLimits } from "@/db/schema";
import { LIMITS, subjectKey } from "@/lib/rate-limit";

// sessions-db (used here to make and read sessions) reaches the database through db().
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { hashPassword, TEMP_PASSWORD_TTL_MS, verifyPassword } from "./password";
import { resetLogin } from "./reset-login";
import { createLocalSession, readLocalSession } from "./sessions-db";

const NOW = new Date("2026-10-19T10:07:30Z");
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let oldHash: string;
let userId: string;
let otherId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  oldHash = await hashPassword("the forgotten one");
}, 120_000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  await db.execute(sql`delete from ops.local_users`);
  await db.execute(sql`delete from ops.rate_limits`);
  [{ id: userId }] = await db
    .insert(localUsers)
    .values({ email: "owner@example.com", passwordHash: oldHash, totpSecretSealed: "v1:iv:ct", totpConfirmedAt: NOW, totpLastStep: 42 })
    .returning({ id: localUsers.id });
  [{ id: otherId }] = await db.insert(localUsers).values({ email: "bo@example.com", passwordHash: oldHash }).returning({ id: localUsers.id });
});

const reset = (email: string) => resetLogin(db as unknown as Db, email, NOW);
const user = async (id: string) => (await db.select().from(localUsers).where(eq(localUsers.id, id)))[0];

describe("resetLogin", () => {
  it("sets a new temporary password (7 days, must change), removes the authenticator and ends every session", async () => {
    const { token: a } = await createLocalSession(userId, { aal: "aal2" });
    const { token: b } = await createLocalSession(userId, { aal: "aal1" });
    const { token: other } = await createLocalSession(otherId, { aal: "aal1" });

    const r = await reset("  Owner@Example.com ");
    if (!r.ok) throw new Error("expected ok");
    expect(r.email).toBe("owner@example.com");
    expect(r.password).toMatch(/^[a-km-np-z2-9]{20}$/);
    expect(r.expiresAt).toEqual(new Date(NOW.getTime() + TEMP_PASSWORD_TTL_MS));
    expect(TEMP_PASSWORD_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);

    const row = await user(userId);
    expect(row).toMatchObject({
      mustChangePassword: true,
      tempPasswordExpiresAt: r.expiresAt,
      totpSecretSealed: null,
      totpConfirmedAt: null,
      totpLastStep: null,
      updatedAt: NOW,
    });
    expect(row.passwordHash).not.toContain(r.password);
    expect(await verifyPassword(r.password, row.passwordHash)).toBe(true);
    expect(await verifyPassword("the forgotten one", row.passwordHash)).toBe(false);

    expect(await readLocalSession(a)).toBeNull();
    expect(await readLocalSession(b)).toBeNull();
    expect(await db.select().from(localSessions).where(eq(localSessions.userId, userId))).toHaveLength(0);
    // Nobody else is touched.
    expect(await readLocalSession(other)).toMatchObject({ userId: otherId });
    expect(await user(otherId)).toMatchObject({ passwordHash: oldHash, mustChangePassword: false, tempPasswordExpiresAt: null });
  });

  it("gives a different password each time", async () => {
    const first = await reset("owner@example.com");
    const second = await reset("owner@example.com");
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(second.password).not.toBe(first.password);
    expect(await verifyPassword(first.password, (await user(userId)).passwordHash)).toBe(false);
  });

  it("clears the lockouts on that email and that user's password change, and no one else's", async () => {
    const windowStart = new Date("2026-10-19T10:00:00Z");
    const keys = {
      email: subjectKey(LIMITS.passwordEmail, "owner@example.com"),
      change: subjectKey(LIMITS.passwordChange, userId),
      otherEmail: subjectKey(LIMITS.passwordEmail, "bo@example.com"),
    };
    await db.insert(rateLimits).values(Object.values(keys).map((key) => ({ key, windowStart, count: 50 })));
    await reset("owner@example.com");
    expect((await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key)).toEqual([keys.otherEmail]);
  });

  it("refuses an unknown email and changes nothing", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    expect(await reset("nobody@example.com")).toEqual({ ok: false, reason: "unknown-email" });
    expect(await reset("")).toEqual({ ok: false, reason: "unknown-email" });
    expect(await user(userId)).toMatchObject({ passwordHash: oldHash, totpConfirmedAt: NOW, mustChangePassword: false });
    expect(await readLocalSession(token)).toMatchObject({ userId });
  });
});
