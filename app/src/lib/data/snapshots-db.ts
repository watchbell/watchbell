import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { snapshots } from "@/db/schema";
import type { State } from "@/lib/status";

// Merges one task's keys into a resource's snapshot (jsonb ||), so the hourly Cloudflare read, the 6-hourly Vercel
// read and the daily TLS and RDAP reads never overwrite each other. The row is created on first write (state unknown).
export async function mergeSnapshot(resourceId: string, patch: Record<string, unknown>, now: Date): Promise<void> {
  await db().insert(snapshots).values({ resourceId, data: patch, collectedAt: now, stateSince: now })
    .onConflictDoUpdate({ target: snapshots.resourceId, set: { data: sql`${snapshots.data} || ${JSON.stringify(patch)}::jsonb`, collectedAt: now } });
}

export async function writeState(resourceId: string, next: State, now: Date): Promise<void> {
  await db().update(snapshots).set({ state: next, stateSince: now }).where(eq(snapshots.resourceId, resourceId));
}
