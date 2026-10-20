import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rateLimits } from "@/db/schema";
import { decide, type Limit, type LimitDecision, peekDecision, subjectKey, windowStart } from "@/lib/rate-limit";

// One atomic statement per hit: insert the window's row or bump it, and read the new count back.
async function dbHit(key: string, start: Date): Promise<number> {
  const [row] = await db()
    .insert(rateLimits)
    .values({ key, windowStart: start, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  // The first hit of a window also sweeps windows older than a day, so the table stays tiny. The hit is
  // already counted, so a failed sweep must not turn into a failed decision; the next window retries it.
  if (row.count === 1) {
    try {
      await db().delete(rateLimits).where(lt(rateLimits.windowStart, new Date(Date.now() - 86_400_000)));
    } catch {
      console.warn("rate limit sweep failed");
    }
  }
  return row.count;
}

export function limit(l: Limit, subject: string): Promise<LimitDecision> {
  return decide(l, subject, { hit: dbHit });
}

// limit(), plus the window the hit landed in and the new count: for callers that may give the hit back (refundLimit)
// or act on a threshold.
export async function hitLimit(l: Limit, subject: string): Promise<LimitDecision & { windowStart: Date; count: number }> {
  const now = new Date();
  let count = 0;
  const d = await decide(l, subject, {
    now,
    hit: async (key, start) => (count = await dbHit(key, start)),
  });
  return { ...d, windowStart: windowStart(now, l.windowSeconds), count };
}

// Gives back one hit in the window it was counted in (never below 0): for limits that count only failures but must
// count every attempt up front, so parallel attempts can't all slip in before the first failure is recorded.
export async function refundLimit(l: Limit, subject: string, hitWindowStart: Date): Promise<void> {
  await db()
    .update(rateLimits)
    .set({ count: sql`${rateLimits.count} - 1` })
    .where(and(eq(rateLimits.key, subjectKey(l, subject)), eq(rateLimits.windowStart, hitWindowStart), gt(rateLimits.count, 0)));
}

// Reads the current window's count without incrementing it.
export async function peekLimit(l: Limit, subject: string): Promise<LimitDecision> {
  const now = new Date();
  const [row] = await db()
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, subjectKey(l, subject)), eq(rateLimits.windowStart, windowStart(now, l.windowSeconds))));
  return peekDecision(l, row?.count ?? 0, now);
}
