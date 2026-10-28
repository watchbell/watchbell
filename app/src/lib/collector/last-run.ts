import "server-only";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { alertRules, collectorRuns } from "@/db/schema";
import { staleLimitMs } from "./staleness";

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

// The CollectorStale rule's limit (Alerts › Rules), 5 minutes when unset or unreadable: when the collector counts as
// late or stopped, for the watchdog, the sidebar footer and Overview alike.
export async function collectorStaleLimit(): Promise<number> {
  const [rule] = await db().select({ threshold: alertRules.threshold }).from(alertRules).where(eq(alertRules.key, "CollectorStale")).limit(1);
  return staleLimitMs(rule?.threshold);
}
