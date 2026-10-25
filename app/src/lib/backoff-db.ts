import "server-only";
import { and, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db/client";
import { rateLimits } from "@/db/schema";
import { BACKOFF, BACKOFF_NAMES, backoffKeys, backoffWaitS, KNOWN_NETWORK_DAYS } from "@/lib/backoff";
import { windowStart } from "@/lib/rate-limit";
import { hitLimit } from "@/lib/rate-limit-db";

// Watchbell 1.2.1 (audit L5/L6): the back-off's state in the existing rate_limits table (no migration). The day's
// failure count is a normal one-day window (`<name>`); each failure also leaves a row under `<name>-last` whose
// window_start is the moment it happened, so the latest one says when the wait started. The table's own sweep drops
// rows older than a day.

const day = (name: string) => ({ name, max: Number.MAX_SAFE_INTEGER, windowSeconds: BACKOFF.windowS });

// Seconds to wait before this subject may try again (0: go ahead).
export async function backoffWait(name: string, subject: string, now: Date = new Date(), o: { free: number; baseS: number; capS: number } = BACKOFF): Promise<number> {
  const [countKey, last] = backoffKeys(name, subject);
  const [c] = await db().select({ count: rateLimits.count }).from(rateLimits)
    .where(and(eq(rateLimits.key, countKey), eq(rateLimits.windowStart, windowStart(now, BACKOFF.windowS))));
  if (!c) return 0;
  const [l] = await db().select({ at: max(rateLimits.windowStart) }).from(rateLimits).where(eq(rateLimits.key, last));
  return backoffWaitS(c.count, l?.at ?? null, now, o);
}

// Counts one failure; returns the day's failures for this subject.
export async function backoffFail(name: string, subject: string, now: Date = new Date()): Promise<number> {
  const d = await hitLimit(day(name), subject);
  await db().insert(rateLimits).values({ key: backoffKeys(name, subject)[1], windowStart: now, count: 1 }).onConflictDoNothing();
  return d.count;
}

// A success starts the subject over.
export async function backoffClear(name: string, subject: string): Promise<void> {
  await db().delete(rateLimits).where(inArray(rateLimits.key, backoffKeys(name, subject)));
}

// Review I2: a network that signed in to an account (email + network, hashed). Stored as one rate_limits row whose
// window_start is when it expires (KNOWN_NETWORK_DAYS ahead), so the table's daily sweep of old windows keeps it.
export async function knownNetwork(email: string, ip: string, now: Date = new Date()): Promise<boolean> {
  const [key] = backoffKeys(BACKOFF_NAMES.knownNet, `${email} ${ip}`);
  const [row] = await db().select({ at: max(rateLimits.windowStart) }).from(rateLimits).where(eq(rateLimits.key, key));
  return !!row?.at && row.at.getTime() > now.getTime();
}

export async function rememberNetwork(email: string, ip: string, now: Date = new Date()): Promise<void> {
  const [key] = backoffKeys(BACKOFF_NAMES.knownNet, `${email} ${ip}`);
  await db().delete(rateLimits).where(eq(rateLimits.key, key));
  await db().insert(rateLimits).values({ key, windowStart: new Date(now.getTime() + KNOWN_NETWORK_DAYS * 86_400_000), count: 1 }).onConflictDoNothing();
}
