import { after } from "next/server";
import { bearerOk } from "@/lib/collector/auth";
import { collectMinGapMs, tooSoon } from "@/lib/collector/cpu-budget";
import { collectorEnv } from "@/lib/collector/env";
import { lastMinuteRunAt } from "@/lib/collector/last-run";
import { runCollector } from "@/lib/collector/run";
import { runMinuteSteps } from "@/lib/collector/runners";
import { demoRouteGone } from "@/lib/demo/simulate";

// 60 s (Vercel Hobby's limit): the collector's own work, then the minute steps (core + private feature) run after the
// response (after()) within the same budget; each bounds itself to the request's start + 60 s less a margin, and a
// failure is only a log line.
export const maxDuration = 60;

// cron-job.org (every 30 minutes since 28 Oct): Authorization: Bearer $COLLECTOR_SECRET.
export async function POST(request: Request) {
  const gone = demoRouteGone(); // the demo has no collector
  if (gone) return gone;
  const started = Date.now();
  const env = collectorEnv();
  if (!env) return Response.json({ error: "Scheduler settings are missing." }, { status: 503 });
  if (!bearerOk(request.headers.get("authorization"), env.COLLECTOR_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // A floor between scheduled runs (cpu-budget.ts): sooner than WATCHBELL_COLLECT_MIN_GAP_MIN after the last run, the
  // call is answered at once, without a run or the minute steps.
  const gap = collectMinGapMs();
  if (gap > 0 && tooSoon(await lastMinuteRunAt(), new Date(), gap)) {
    return Response.json({ skipped: true, reason: `The last run was less than ${Math.round(gap / 60_000)} minutes ago.` });
  }
  const summary = await runCollector("cron_job_org");
  after(() => runMinuteSteps(started));
  return Response.json(summary);
}
