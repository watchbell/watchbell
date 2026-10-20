import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers } from "@/db/schema";
import { hashToken } from "./session-token";

const h = vi.hoisted(() => ({ db: undefined as unknown, ready: vi.fn(async () => {}) }));
vi.mock("@/db/client", () => ({ db: () => h.db, ready: h.ready }));

import { updateSessionLocal } from "./proxy";
import { createLocalSession, revokeLocalSession } from "./sessions-db";

const DAY = 24 * 60 * 60 * 1000;
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;

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
  h.ready.mockClear();
  await db.execute(sql`delete from ops.local_users`);
  [{ id: userId }] = await db.insert(localUsers).values({ email: "a@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" }).returning({ id: localUsers.id });
});

const req = (token?: string) => new NextRequest("http://127.0.0.1:3100/", token === undefined ? {} : { headers: { cookie: `wp_session=${token}` } });
const cleared = (res: Response) => /^wp_session=; Path=\/; Max-Age=0;.*HttpOnly.*SameSite=lax/i.test(res.headers.get("set-cookie") ?? "");

describe("updateSessionLocal (self-host proxy)", () => {
  it("no cookie: signed out, no database work, nothing set", async () => {
    const { response, userId: id } = await updateSessionLocal(req());
    expect(id).toBeNull();
    expect(h.ready).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("a live session: its user, after ready(), and the cookie is left alone", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal1" });
    const { response, userId: id } = await updateSessionLocal(req(token));
    expect(id).toBe(userId);
    expect(h.ready).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("an unknown or junk token: signed out and the cookie cleared", async () => {
    for (const token of ["A".repeat(43), "junk"]) {
      const { response, userId: id } = await updateSessionLocal(req(token));
      expect(id).toBeNull();
      expect(cleared(response)).toBe(true);
    }
  });

  it("a revoked session: signed out and the cookie cleared", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" });
    await revokeLocalSession(token);
    const { response, userId: id } = await updateSessionLocal(req(token));
    expect(id).toBeNull();
    expect(cleared(response)).toBe(true);
  });

  it("idle over 7 days: signed out and the cookie cleared", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" }, new Date(Date.now() - 7 * DAY - 60_000));
    const { response, userId: id } = await updateSessionLocal(req(token));
    expect(id).toBeNull();
    expect(cleared(response)).toBe(true);
  });

  it("past the 30-day absolute expiry though recently used: signed out and the cookie cleared", async () => {
    const { token } = await createLocalSession(userId, { aal: "aal2" }, new Date(Date.now() - 30 * DAY - 60_000));
    await db.update(localSessions).set({ lastSeenAt: new Date() }).where(eq(localSessions.tokenHash, hashToken(token)));
    const { response, userId: id } = await updateSessionLocal(req(token));
    expect(id).toBeNull();
    expect(cleared(response)).toBe(true);
  });
});
