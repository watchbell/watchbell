import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, rateLimits } from "@/db/schema";
import { BACKOFF_NAMES, backoffKeys } from "@/lib/backoff";
import { knownNetwork } from "@/lib/backoff-db";
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

  // Review T2b-fix I-3: a session in use keeps its network known for the account (KNOWN_NETWORK_DAYS from the last
  // refresh), refreshed at most once a day per session and network.
  describe("keeps the network known while the session is used", () => {
    const knownUntil = async (ip: string) => {
      const [key] = backoffKeys(BACKOFF_NAMES.knownNet, `a@example.com ${ip}`);
      return (await db.select({ at: rateLimits.windowStart }).from(rateLimits).where(eq(rateLimits.key, key)))[0]?.at ?? null;
    };
    const fromIp = (token: string, ip: string) =>
      new NextRequest("http://127.0.0.1:3100/", { headers: { cookie: `wp_session=${token}`, "x-forwarded-for": ip } });
    beforeEach(async () => {
      await db.execute(sql`delete from ops.rate_limits`);
      vi.stubEnv("WATCHBELL_TRUSTED_PROXY_HOPS", "1");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it("refreshes on use, at most once a day, and the network is known for 90 days from then", async () => {
      const t0 = new Date("2026-10-01T08:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"], now: t0 });
      const { token } = await createLocalSession(userId, { aal: "aal2" });
      vi.setSystemTime(new Date(t0.getTime() + 5 * DAY));
      expect((await updateSessionLocal(fromIp(token, "198.51.100.9"))).userId).toBe(userId);
      expect(await knownUntil("198.51.100.9")).toEqual(new Date(t0.getTime() + 95 * DAY));
      // Within the day: no second write.
      vi.setSystemTime(new Date(t0.getTime() + 5 * DAY + 3_600_000));
      await updateSessionLocal(fromIp(token, "198.51.100.9"));
      expect(await knownUntil("198.51.100.9")).toEqual(new Date(t0.getTime() + 95 * DAY));
      // A day later: refreshed again.
      vi.setSystemTime(new Date(t0.getTime() + 6 * DAY + 60_000));
      await updateSessionLocal(fromIp(token, "198.51.100.9"));
      expect(await knownUntil("198.51.100.9")).toEqual(new Date(t0.getTime() + 96 * DAY + 60_000));
      expect(await knownNetwork("a@example.com", "198.51.100.9", new Date(t0.getTime() + 95 * DAY))).toBe(true);
    });

    it("nothing without a trusted proxy, for an ended session, or without a session", async () => {
      vi.stubEnv("WATCHBELL_TRUSTED_PROXY_HOPS", "");
      const { token } = await createLocalSession(userId, { aal: "aal2" });
      await updateSessionLocal(fromIp(token, "198.51.100.10"));
      expect(await knownUntil("198.51.100.10")).toBeNull();
      vi.stubEnv("WATCHBELL_TRUSTED_PROXY_HOPS", "1");
      await revokeLocalSession(token);
      await updateSessionLocal(fromIp(token, "198.51.100.11"));
      expect(await knownUntil("198.51.100.11")).toBeNull();
      expect(await db.select().from(rateLimits)).toHaveLength(0);
    });
  });
});
