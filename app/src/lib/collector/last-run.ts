import "server-only";
import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { collectorRuns } from "@/db/schema";

// A leaf module (no import of run.ts), so the alert code can ask when the collector last ran without an import cycle.

// When the collector last finished a run on its own schedule (or by hand), whether or not that run had problems:
// a run that reports an error is still proof the collector is alive. Vercel's daily job doesn't count.
export async function lastCollectorRunAt(): Promise<Date | null> {
  const [row] = await db().select({ at: collectorRuns.finishedAt }).from(collectorRuns)
    .where(and(isNotNull(collectorRuns.finishedAt), inArray(collectorRuns.trigger, ["cron_job_org", "qstash", "manual"])))
    .orderBy(desc(collectorRuns.finishedAt)).limit(1);
  return row?.at ?? null;
}

// When the PRIMARY scheduler (cron-job.org, or a manual run) last finished a run. The watchdog judges this one,
// so its own backup runs (trigger "qstash") can't make a dead primary look alive.
export async function lastMinuteRunAt(): Promise<Date | null> {
  const [row] = await db().select({ at: collectorRuns.finishedAt }).from(collectorRuns)
    .where(and(isNotNull(collectorRuns.finishedAt), inArray(collectorRuns.trigger, ["cron_job_org", "manual"])))
    .orderBy(desc(collectorRuns.finishedAt)).limit(1);
  return row?.at ?? null;
}
