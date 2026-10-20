import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers } from "@/db/schema";
import { hashToken } from "./session-token";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import {
  createLocalSession,
  deleteExpiredLocalSessions,
  localSessionUserId,
  readLocalSession,
  replaceLocalSession,
  revokeAllLocalSessions,
  revokeLocalSession,
} from "./sessions-db";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-19T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;
let otherId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await db.execute(sql`delete from ops.local_users`);
  const pw = "scrypt$32768$8$1$c2FsdA==$aGFzaA==";
  [{ id: userId }] = await db.insert(localUsers).values({ email: "a@example.com", passwordHash: pw }).returning({ id: localUsers.id });
  [{ id: otherId }] = await db.insert(localUsers).values({ email: "b@example.com", passwordHash: pw }).returning({ id: localUsers.id });
});

const row = async (token: string) => (await db.select().from(localSessions).where(eq(localSessions.tokenHash, hashToken(token))))[0];

describe("local sessions", () => {
  it("stores only the token's hash, with a 30-day absolute expiry and a capped user agent", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal1", userAgent: "x".repeat(500) }, T0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const r = await row(token);
    expect(r.tokenHash).toBe(hashToken(token));
    expect(r.tokenHash).not.toContain(token);
    expect(r.expiresAt.getTime()).toBe(T0.getTime() + 30 * DAY);
    expect(r.userAgent).toHaveLength(200);
    expect(r.aal).toBe("aal1");
    const { token: t2 } = await createLocalSession(userId, { aal: "aal2", userAgent: "" }, T0);
    expect((await row(t2)).userAgent).toBeNull();
  });

  it("a valid token gives the user, email, the row's aal and whether the password must change", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal1" }, T0);
    expect(await readLocalSession(token, at(1000))).toEqual({ userId, email: "a@example.com", aal: "aal1", mustChangePassword: false });
    await db.update(localUsers).set({ mustChangePassword: true }).where(eq(localUsers.id, otherId));
    const { token: t2 } = await createLocalSession(otherId, { aal: "aal2" }, T0);
    expect(await readLocalSession(t2, at(1000))).toEqual({ userId: otherId, email: "b@example.com", aal: "aal2", mustChangePassword: true });
  });

  it("touches last_seen_at at most once a minute", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal1" }, T0);
    await readLocalSession(token, at(59_000));
    expect((await row(token)).lastSeenAt.getTime()).toBe(T0.getTime());
    await readLocalSession(token, at(61_000));
    expect((await row(token)).lastSeenAt.getTime()).toBe(T0.getTime() + 61_000);
    await readLocalSession(token, at(90_000));
    expect((await row(token)).lastSeenAt.getTime()).toBe(T0.getTime() + 61_000);
  });

  it("keeps a session alive while it is used, and rejects it after 7 idle days", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal1" }, T0);
    expect(await readLocalSession(token, at(6 * DAY))).not.toBeNull();
    expect(await readLocalSession(token, at(12 * DAY))).not.toBeNull(); // 6 days after the last use
    expect(await readLocalSession(token, at(19 * DAY + 1))).toBeNull(); // 7 days + 1 ms idle
    expect(await row(token)).toBeUndefined(); // dropped, not just refused
  });

  it("rejects a session past its 30-day absolute expiry even when used every day", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" }, T0);
    for (let d = 1; d < 30; d++) expect(await readLocalSession(token, at(d * DAY))).not.toBeNull();
    expect(await readLocalSession(token, at(30 * DAY))).toBeNull();
  });

  it("rejects unknown, malformed and revoked tokens", async () => {
    expect(await readLocalSession("A".repeat(43), T0)).toBeNull();
    expect(await readLocalSession("", T0)).toBeNull();
    expect(await readLocalSession("not a token", T0)).toBeNull();
    expect(await readLocalSession("A".repeat(44), T0)).toBeNull();
    const { token } = await createLocalSession(userId, { aal: "aal1" }, T0);
    const { token: keep } = await createLocalSession(userId, { aal: "aal1" }, T0);
    await revokeLocalSession(token);
    expect(await readLocalSession(token, T0)).toBeNull();
    expect(await readLocalSession(keep, T0)).not.toBeNull();
  });

  it("revokes every session of one user only", async () => {
    const a1 = (await createLocalSession(userId, { aal: "aal1" }, T0)).token;
    const a2 = (await createLocalSession(userId, { aal: "aal2" }, T0)).token;
    const b = (await createLocalSession(otherId, { aal: "aal1" }, T0)).token;
    await revokeAllLocalSessions(userId);
    expect(await readLocalSession(a1, T0)).toBeNull();
    expect(await readLocalSession(a2, T0)).toBeNull();
    expect(await readLocalSession(b, T0)).not.toBeNull();
  });

  it("names a token's user even after the session ended, so a global sign-out still reaches the other devices", async () => {
    // Ended (40 days old) but not yet swept: nobody presented it since.
    const { token } = await createLocalSession(userId, { aal: "aal1" }, new Date(Date.now() - 40 * DAY));
    expect(await localSessionUserId(token)).toBe(userId);
    expect(await readLocalSession(token)).toBeNull();
    expect(await localSessionUserId("A".repeat(43))).toBeNull();
    expect(await localSessionUserId("not a token")).toBeNull();
  });

  it("a deleted user's sessions go with it", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" }, T0);
    await db.delete(localUsers).where(eq(localUsers.id, userId));
    expect(await readLocalSession(token, T0)).toBeNull();
  });

  it("replaces a live session with a new token at the new aal; the old token stops working", async () => {
    const { token: old } = await createLocalSession(userId, { aal: "aal1" }, T0);
    const r = await replaceLocalSession(old, { aal: "aal2", userAgent: "ua" }, at(1000));
    expect(r?.userId).toBe(userId);
    expect(r?.token).not.toBe(old);
    expect(await row(old)).toBeUndefined();
    expect(await readLocalSession(r!.token, at(2000))).toEqual({ userId, email: "a@example.com", aal: "aal2", mustChangePassword: false });
    expect(await replaceLocalSession(old, { aal: "aal2" }, at(3000))).toBeNull();
  });

  it("does not replace an ended, unknown or malformed session", async () => {
    const { token: idle } = await createLocalSession(userId, { aal: "aal1" }, T0);
    expect(await replaceLocalSession(idle, { aal: "aal2" }, at(8 * DAY))).toBeNull();
    expect(await replaceLocalSession("A".repeat(43), { aal: "aal2" }, T0)).toBeNull();
    expect(await replaceLocalSession("", { aal: "aal2" }, T0)).toBeNull();
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from ops.local_sessions where aal = 'aal2'`)).rows as { n: number }[];
    expect(n).toBe(0);
  });

  it("deletes idle and expired sessions and keeps live ones", async () => {
    const live = (await createLocalSession(userId, { aal: "aal1" }, at(5 * DAY))).token;
    const idle = (await createLocalSession(userId, { aal: "aal1" }, T0)).token;
    expect(await deleteExpiredLocalSessions(at(7 * DAY + 1))).toBe(1);
    expect(await row(idle)).toBeUndefined();
    expect(await row(live)).toBeDefined();
  });
});
