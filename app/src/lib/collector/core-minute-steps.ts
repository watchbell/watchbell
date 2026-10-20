import { guardPool } from "@/lib/data/pool-guard";
import { isCloud } from "@/lib/mode";
import { scrapeSupabaseMetrics } from "@/lib/data/supabase-metrics-db";

// The core's own minute steps, run by /api/collect after the response like the private feature's minuteSteps (same
// shape, same rules: cheap when nothing is due, bounded by ctx.deadline, never throwing).
export type MinuteStep = { name: string; run: (now: Date, ctx?: { deadline: number }) => Promise<void> };

export const CORE_MINUTE_STEPS: MinuteStep[] = [
  // Pool guard first: at 10 of the 15 pooler slots, the longest-idle connections of this app are closed (owner 16 Oct).
  // The pooler only exists in cloud; selfhost/demo use an in-process database, so the step is a no-op there.
  { name: "pool-guard", run: async () => { if (!isCloud()) return; await guardPool().catch((e) => console.warn("pool guard failed:", e instanceof Error ? e.message.slice(0, 160) : "error")); } },
  // Stage 12: Supabase compute (Metrics API), at most once per 5-minute slot, only for projects with a metrics key.
  { name: "supabase-metrics", run: async (now, ctx) => { await scrapeSupabaseMetrics(now, ctx?.deadline ?? now.getTime() + 30_000); } },
];
