import "server-only";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, collectorRuns } from "@/db/schema";

// Overview → Collector cell: the last finished minute-collector run (any minute trigger, like the sidebar). Ordered by
// started_at because that column has the index (collector_runs_started); runs finish in start order in practice.
export async function lastMinuteRun(): Promise<{ finishedAt: Date; durationMs: number | null; checks: number } | null> {
  const [r] = await db().select({ finishedAt: collectorRuns.finishedAt, durationMs: collectorRuns.durationMs, checks: collectorRuns.checks })
    .from(collectorRuns)
    .where(and(isNotNull(collectorRuns.finishedAt), inArray(collectorRuns.trigger, ["cron_job_org", "qstash", "manual"])))
    .orderBy(desc(collectorRuns.startedAt)).limit(1);
  return r?.finishedAt ? { finishedAt: r.finishedAt, durationMs: r.durationMs, checks: r.checks } : null;
}

// Overview → credential banner. Uses the stored status (set by tests, Sync and the collector) rather than decrypting
// every credential on each 60 s refresh.
export async function brokenAccounts(): Promise<{ provider: string; label: string }[]> {
  return db().select({ provider: accounts.provider, label: accounts.label }).from(accounts)
    .where(eq(accounts.status, "error")).orderBy(accounts.provider, accounts.label).limit(50);
}
