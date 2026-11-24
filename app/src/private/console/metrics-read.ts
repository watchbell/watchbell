import "server-only";
import { ttlMemo } from "@/lib/memo";
import { isDemo } from "@/lib/mode";
import { metricsText } from "./metrics";
import { snapAlertCounts, snapMonitorItems } from "./snapshot";

// 1.8.5: /api/v1/metrics answers from this per-instance memo, so a scrape every 15 s still reads the database at most
// once a minute (Vercel CPU, the pooler's slots). A failed read is not kept (ttlMemo).
export const METRICS_TTL_MS = 60_000;
// The demo (each visitor has a database of its own) never keeps an answer; its proxy already answers 404 here.
export const metricsMemo = ttlMemo(async () => {
  const [monitors, alertsBySeverity] = await Promise.all([snapMonitorItems(new Date()), snapAlertCounts()]);
  return metricsText({ monitors, alertsBySeverity });
}, METRICS_TTL_MS, Date.now, () => isDemo());
