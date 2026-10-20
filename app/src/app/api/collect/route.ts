import { after } from "next/server";
import { bearerOk } from "@/lib/collector/auth";
import { collectorEnv } from "@/lib/collector/env";
import { runCollector } from "@/lib/collector/run";
import { runMinuteSteps } from "@/lib/collector/runners";
import { demoRouteGone } from "@/lib/demo/simulate";

// 60 s (Vercel Hobby's limit): the collector's own work, then the minute steps (core + private feature) run after the
// response (after()) within the same budget; each bounds itself to the request's start + 60 s less a margin, and a
// failure is only a log line.
export const maxDuration = 60;

// cron-job.org, every minute: Authorization: Bearer $COLLECTOR_SECRET.
export async function POST(request: Request) {
  const gone = demoRouteGone(); // the demo has no collector
  if (gone) return gone;
  const started = Date.now();
  const env = collectorEnv();
  if (!env) return Response.json({ error: "Scheduler settings are missing." }, { status: 503 });
  if (!bearerOk(request.headers.get("authorization"), env.COLLECTOR_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const summary = await runCollector("cron_job_org");
  after(() => runMinuteSteps(started));
  return Response.json(summary);
}
