import "server-only";
import { and, eq, gt, lte, ne, or } from "drizzle-orm";
import { type Db, db } from "@/db/client";
import { localSessions, localUsers } from "@/db/schema";
import { hashToken, newSessionToken } from "./session-token";

// Self-host sessions. The cookie holds a random token; the table holds only its sha256. A session ends after 7 days
// without use (rolling last_seen_at) and 30 days after it was created, whichever comes first.
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
// last_seen_at only needs minute precision for the idle rule; writing it on every request would be a write per click.
const TOUCH_EVERY_MS = 60_000;
const USER_AGENT_MAX = 200;
// newSessionToken(): 32 bytes as base64url. Anything else is junk and never reaches the database.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type Aal = "aal1" | "aal2";
// A transaction works too, so a session change can commit together with the change that caused it.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;
// `mustChangePassword`: the account still has a temporary password (read in the same query, for the console's gates).
export type LocalSession = { userId: string; email: string; aal: Aal; mustChangePassword: boolean };

const idleCutoff = (now: Date) => new Date(now.getTime() - SESSION_IDLE_MS);
const live = (now: Date) => and(gt(localSessions.expiresAt, now), gt(localSessions.lastSeenAt, idleCutoff(now)));

export async function createLocalSession(
  userId: string,
  opts: { aal: Aal; userAgent?: string | null },
  now = new Date(),
  conn: Conn = db(),
): Promise<{ token: string }> {
  const { token, hash } = newSessionToken();
  await conn
    .insert(localSessions)
    .values({
      userId,
      tokenHash: hash,
      aal: opts.aal,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      userAgent: opts.userAgent ? opts.userAgent.slice(0, USER_AGENT_MAX) : null,
    });
  return { token };
}

// The session behind a cookie token, or null when it is unknown, revoked, idle too long or past its absolute expiry.
// An ended session's row is deleted on the way out.
export async function readLocalSession(token: string, now = new Date()): Promise<LocalSession | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db()
    .select({
      id: localSessions.id,
      userId: localSessions.userId,
      aal: localSessions.aal,
      lastSeenAt: localSessions.lastSeenAt,
      expiresAt: localSessions.expiresAt,
      email: localUsers.email,
      mustChangePassword: localUsers.mustChangePassword,
    })
    .from(localSessions)
    .innerJoin(localUsers, eq(localUsers.id, localSessions.userId))
    .where(eq(localSessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime() || row.lastSeenAt.getTime() <= idleCutoff(now).getTime()) {
    await db().delete(localSessions).where(eq(localSessions.id, row.id));
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    await db().update(localSessions).set({ lastSeenAt: now }).where(eq(localSessions.id, row.id));
  }
  return { userId: row.userId, email: row.email, aal: row.aal, mustChangePassword: row.mustChangePassword };
}

// Privilege change (TOTP verified): the old token ends and a fresh one carries the new aal, so a token captured while
// the session was aal1 never becomes aal2. Null when the old session is gone or has ended (nothing new is created).
export async function replaceLocalSession(
  oldToken: string,
  opts: { aal: Aal; userAgent?: string | null },
  now = new Date(),
  conn: Conn = db(),
): Promise<{ userId: string; token: string } | null> {
  if (!TOKEN_SHAPE.test(oldToken)) return null;
  const [old] = await conn
    .delete(localSessions)
    .where(and(eq(localSessions.tokenHash, hashToken(oldToken)), live(now)))
    .returning({ userId: localSessions.userId });
  if (!old) return null;
  const { token } = await createLocalSession(old.userId, opts, now, conn);
  return { userId: old.userId, token };
}

export async function revokeLocalSession(token: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return;
  await db().delete(localSessions).where(eq(localSessions.tokenHash, hashToken(token)));
}

// Whose session a token was, live or not: signing out everywhere must work even when this browser's own session has
// already ended (idle or expired), so the other devices still get signed out.
export async function localSessionUserId(token: string): Promise<string | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db().select({ userId: localSessions.userId }).from(localSessions).where(eq(localSessions.tokenHash, hashToken(token))).limit(1);
  return row?.userId ?? null;
}

export async function revokeAllLocalSessions(userId: string): Promise<void> {
  await db().delete(localSessions).where(eq(localSessions.userId, userId));
}

// Every session of the user except the one behind `keepToken` (a password change ends the other devices).
export async function revokeOtherLocalSessions(userId: string, keepToken: string, conn: Conn = db()): Promise<void> {
  await conn.delete(localSessions).where(and(eq(localSessions.userId, userId), ne(localSessions.tokenHash, hashToken(keepToken))));
}

// Housekeeping: rows of sessions that ended without anyone presenting their cookie again. Returns how many went.
export async function deleteExpiredLocalSessions(now = new Date()): Promise<number> {
  const rows = await db()
    .delete(localSessions)
    .where(or(lte(localSessions.expiresAt, now), lte(localSessions.lastSeenAt, idleCutoff(now))))
    .returning({ id: localSessions.id });
  return rows.length;
}
