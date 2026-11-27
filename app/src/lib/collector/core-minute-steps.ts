import { resolveStaleExternal } from "@/lib/data/ingest-db";
import { guardPool } from "@/lib/data/pool-guard";
import { isCloud } from "@/lib/mode";
import { pausedSections } from "@/lib/data/sections-db";
import { scrapeSupabaseMetrics } from "@/lib/data/supabase-metrics-db";

// The core's own minute steps, run by /api/collect after the response like the private feature's minuteSteps (same
// shape, same rules: cheap when nothing is due, bounded by ctx.deadline, never throwing).
export type MinuteStep = { name: string; run: (now: Date, ctx?: { deadline: number }) => Promise<void> };

// Watchbell 1.8.6: at most every 5 minutes per server instance (one indexed update; nothing to do most of the time).
const STALE_EVERY_MS = 5 * 60_000;
let staleRunAt = 0;

export const CORE_MINUTE_STEPS: MinuteStep[] = [
  // Pool guard first: at 10 of the 15 pooler slots, the longest-idle connections of this app are closed (owner 16 Oct).
  // The pooler only exists in cloud; selfhost/demo use an in-process database, so the step is a no-op there.
  { name: "pool-guard", run: async () => { if (!isCloud()) return; await guardPool().catch((e) => console.warn("pool guard failed:", e instanceof Error ? e.message.slice(0, 160) : "error")); } },
  // Stage 12: Supabase compute (Metrics API), at most once per 5-minute slot, only for projects with a metrics key.
  // Watchbell 1.2: paused while the Database section is turned off (Manage › Sections).
  { name: "supabase-metrics", run: async (now, ctx) => {
    if ((await pausedSections()).has("database")) return;
    await scrapeSupabaseMetrics(now, ctx?.deadline ?? now.getTime() + 30_000);
  } },
  // Watchbell 1.8.6: an Alertmanager alert with no word for 24 h resolves as stale (Alertmanager re-sends a firing alert
  // every repeat_interval, 4 h by default), and the Watchbell test alert closes after 5 minutes. Every edition.
  { name: "external-stale", run: async (now) => {
    if (now.getTime() - staleRunAt < STALE_EVERY_MS) return;
    staleRunAt = now.getTime();
    await resolveStaleExternal(now).catch((e: unknown) => console.warn("external stale failed:", e instanceof Error ? e.name : "error"));
  } },
];
