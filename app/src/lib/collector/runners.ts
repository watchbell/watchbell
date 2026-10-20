import { CORE_MINUTE_STEPS } from "./core-minute-steps";
import { runDaily } from "./daily";
import { runExtraSteps } from "./extra-steps";
import { runCollector, type RunSummary, type Trigger } from "./run";
import { extensions } from "@/lib/extensions";

// 60 s (Vercel Hobby's limit) less a margin: the minute steps bound themselves to ctx.deadline.
const MINUTE_BUDGET_MS = 60_000;
const STEP_MARGIN_MS = 5_000;

// The core's own minute steps first (Stage 12 Supabase compute), then the private feature's; a failure is only a log line.
export async function runMinuteSteps(started: number): Promise<void> {
  const steps = [...CORE_MINUTE_STEPS, ...(extensions.minuteSteps ?? [])];
  if (!steps.length) return;
  const now = new Date();
  const ctx = { deadline: started + MINUTE_BUDGET_MS - STEP_MARGIN_MS };
  for (const step of steps) {
    try {
      await step.run(now, ctx);
    } catch {
      console.warn(`minute step ${step.name} failed`);
    }
  }
}

// What the HTTP route and the self-host scheduler both run each minute.
export async function runMinute(trigger: Trigger, started = Date.now()): Promise<RunSummary> {
  const summary = await runCollector(trigger);
  await runMinuteSteps(started);
  return summary;
}

// The daily steps of the private feature run after the core ones; each failure is a step error, never a failed run.
export async function runDailyAll(): Promise<RunSummary> {
  return runExtraSteps(await runDaily(), extensions.dailySteps ?? []);
}
