import "server-only";
import { gte, max, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { deployDays } from "@/db/report-schema";
import { deployments } from "@/db/schema";
import { readRetentionDays } from "@/lib/data/settings-db";
import { timeZone } from "@/lib/time";
import { zoneDay } from "@/lib/zone-day";

// Watchbell 1.7 (spec §5): deployments are deleted after 30 days, so the monthly report would miss the first days of a
// month. The daily job keeps a per-app, per-day count of finished deploys first, kept as long as the hourly rollups.

const DAY_MS = 86_400_000;
const RECOUNT_DAYS = 2; // today and the two days before are counted again on every run (late-arriving deploys)

export { zoneDay };

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export type DeployDay = { resourceId: string; day: string; ok: number; failed: number };

// READY counts as ok, ERROR as failed; builds still running and cancelled ones aren't deploys a client cares about.
export function summarizeDeploys(rows: { resourceId: string; state: string; createdAtProvider: Date }[], zone: string): DeployDay[] {
  const by = new Map<string, DeployDay>();
  for (const r of rows) {
    const s = r.state.toUpperCase();
    if (s !== "READY" && s !== "ERROR") continue;
    const day = zoneDay(r.createdAtProvider, zone);
    const k = `${r.resourceId}|${day}`;
    const cur = by.get(k) ?? { resourceId: r.resourceId, day, ok: 0, failed: 0 };
    if (s === "READY") cur.ok++;
    else cur.failed++;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId) || a.day.localeCompare(b.day));
}

// Counts again from two days before the newest summarised day (the first run: every deployment still kept). The read
// starts a day earlier than the first day kept, so a day is only written when all of it was read, whatever the zone.
export async function stepDeployDays(now: Date, zone: string = timeZone()): Promise<void> {
  const [latest] = await db().select({ day: max(deployDays.day) }).from(deployDays);
  const fromDay = latest?.day ? shiftDay(latest.day, -RECOUNT_DAYS) : null;
  const read = db().select({ resourceId: deployments.resourceId, state: deployments.state, createdAtProvider: deployments.createdAtProvider }).from(deployments);
  const rows = fromDay ? await read.where(gte(deployments.createdAtProvider, new Date(Date.parse(`${fromDay}T00:00:00Z`) - DAY_MS))) : await read;
  const today = zoneDay(now, zone);
  // Final review (1.7.1): the live and previous production deployments are never deleted, so the first run starts
  // where the deployments table is still complete (its retention), not at the oldest deployment it happens to keep.
  const firstKept = fromDay ? null : zoneDay(new Date(now.getTime() - (await readRetentionDays()).deployments * DAY_MS), zone);
  const days = summarizeDeploys(rows, zone).filter((r) => (fromDay ? r.day >= fromDay : r.day >= (firstKept as string)) && r.day <= today);
  if (!days.length) return;
  await db().insert(deployDays).values(days)
    .onConflictDoUpdate({ target: [deployDays.resourceId, deployDays.day], set: { ok: sql`excluded.ok`, failed: sql`excluded.failed` } });
}
