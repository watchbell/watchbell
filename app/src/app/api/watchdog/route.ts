import { Receiver } from "@upstash/qstash";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { collectorEnv } from "@/lib/collector/env";
import { lastMinuteRunAt } from "@/lib/collector/last-run";
import { runCollector } from "@/lib/collector/run";
import { isStale } from "@/lib/collector/staleness";
import { evaluateAlerts } from "@/lib/data/alerts-db";
import { recordEvents } from "@/lib/data/events-write";
import { deliverPending } from "@/lib/data/notify-db";
import { demoRouteGone } from "@/lib/demo/simulate";
import { serverEnv } from "@/lib/env";

export const maxDuration = 30;

// Every failure answers 200, so QStash doesn't retry-storm an outage; the log gets the error's name only.
function failed(stale: boolean | null, e: unknown) {
  console.warn("Watchdog failed:", e instanceof Error ? e.name : "error");
  return Response.json({ stale, ran: false });
}

// Upstash QStash, every 5 minutes. If the minute collector (cron-job.org) stopped, record it and run a collection ourselves.
export async function POST(request: Request) {
  const gone = demoRouteGone(); // the demo has no collector to watch
  if (gone) return gone;
  const env = collectorEnv();
  if (!env) return Response.json({ error: "Scheduler settings are missing." }, { status: 503 });
  const body = await request.text();
  // The signature is bound to this endpoint's URL: QStash must be configured with exactly SITE_URL + /api/watchdog.
  let url: string;
  try {
    url = `${serverEnv().SITE_URL.replace(/\/+$/, "")}/api/watchdog`;
  } catch (e) {
    return failed(null, e);
  }
  // devMode false: a stray QSTASH_DEV variable must never swap in the local dev server's signing keys.
  const receiver = new Receiver({ currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY, nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY, devMode: false });
  const valid = await receiver.verify({ signature: request.headers.get("upstash-signature") ?? "", body, url }).catch(() => false);
  if (!valid) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // null until the staleness is known: a failure before that can't say whether the collector stopped.
  let stale: boolean | null = null;
  try {
    const now = new Date();
    await db().insert(settings).values({ key: "watchdog.lastPing", value: { at: now.toISOString() } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { at: now.toISOString() }, updatedAt: now } });
    // Judge the primary scheduler only: the watchdog's own runs must not make a dead cron-job.org look alive.
    const last = await lastMinuteRunAt();
    stale = isStale(last, now);
    // CollectorStale through the alert engine, so it is opened, notified and resolved like any other rule. Only this
    // rule: the watchdog shouldn't judge the others from a collector it thinks is dead.
    await evaluateAlerts(now, { only: ["CollectorStale"] })
      // The collector is the thing that may be broken, so the watchdog also sends what the alert engine just queued.
      .then(() => deliverPending(now, Date.now() + 8_000))
      .catch((e) => console.warn("watchdog alerts failed:", e instanceof Error ? e.name : "error"));
    if (!stale) return Response.json({ stale: false });

    // One "Collector stopped" row, counted: a repeat within the hour bumps it (R2), however long the outage lasts.
    await recordEvents([{ type: "system", kind: "warn", message: "Collector stopped", detail: last ? `Last run ${Math.round((now.getTime() - last.getTime()) / 60_000)} min ago` : "No run yet", resourceId: null, at: now }]);
    await runCollector("qstash");
    return Response.json({ stale: true, ran: true });
  } catch (e) {
    return failed(stale, e);
  }
}
