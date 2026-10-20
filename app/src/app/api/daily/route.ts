import { bearerOk } from "@/lib/collector/auth";
import { collectorEnv } from "@/lib/collector/env";
import { runDailyAll } from "@/lib/collector/runners";
import { demoRouteGone } from "@/lib/demo/simulate";

export const maxDuration = 60;

// Vercel Cron (vercel.json) sends Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const gone = demoRouteGone(); // the demo has no daily job
  if (gone) return gone;
  const env = collectorEnv();
  if (!env) return Response.json({ error: "Scheduler settings are missing." }, { status: 503 });
  if (!bearerOk(request.headers.get("authorization"), env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // 5c: the private feature's daily steps (retention of ai_usage / ai_notes …) run after the core steps; each failure
  // is a step error in the answer, never a failed run.
  return Response.json(await runDailyAll());
}
