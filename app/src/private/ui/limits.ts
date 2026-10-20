import type { Limit } from "@/lib/rate-limit";

// Task 4's own limits (core rate-limit.ts stays untouched): the Playground, per owner, 30 messages per 10 minutes.
// Log export and quota edits reuse the core LIMITS.credential / sync budgets in their actions.
export const LIMITS = {
  playground: { name: "playground", max: 30, windowSeconds: 600 },
} as const satisfies Record<string, Limit>;
