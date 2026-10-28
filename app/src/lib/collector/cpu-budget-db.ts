import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { recordEvents } from "@/lib/data/events-write";
import { addRunCpu, CPU_DAY_WARN_MS } from "./cpu-budget";

export const CPU_DAY_KEY = "collector.cpuDay";

// Adds one run's CPU to today's total (settings, one row) and, the first time today's total passes the warning line,
// records a warning event. Runs don't overlap (the collector's lease), so read-then-write is enough. Never throws:
// counting must not fail a run.
export async function recordRunCpu(ms: number, now: Date = new Date()): Promise<void> {
  try {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, CPU_DAY_KEY)).limit(1);
    const { next, crossed } = addRunCpu(row?.value, ms, now);
    await db().insert(settings).values({ key: CPU_DAY_KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } });
    if (crossed) {
      await recordEvents([{
        type: "system", kind: "warn", message: "Collector CPU high today",
        detail: `${Math.round(next.ms / 1000)} s in ${next.runs} runs, over ${CPU_DAY_WARN_MS / 60_000} min (Vercel Hobby allows about 8 min a day). Check the cron-job.org schedule.`,
        resourceId: null, at: now,
      }]);
    }
  } catch (e) {
    console.warn("collector cpu count failed:", e instanceof Error ? e.name : "error");
  }
}
