import type { RunSummary } from "./run";
import { safeError } from "./safe-error";

export type ExtraStep = { name: string; run: (now: Date) => Promise<void> };

// Daily steps the private feature registers (5c, @/lib/extensions dailySteps). They run after the core steps, one at
// a time; a failing step becomes "<name>: <safe error>" in the summary and never fails the run or stops the next step.
// The collector run row was already written by runDaily, so these show in the route's answer only.
export async function runExtraSteps(summary: RunSummary, steps: readonly ExtraStep[], now = new Date()): Promise<RunSummary> {
  if (summary.skipped || steps.length === 0) return summary;
  const tasks = [...summary.tasks];
  const errors = [...summary.errors];
  for (const step of steps) {
    try {
      await step.run(now);
      tasks.push(step.name);
    } catch (e) {
      errors.push(`${step.name}: ${safeError(e)}`);
    }
  }
  return { ...summary, tasks, errors, ok: errors.length === 0 };
}
