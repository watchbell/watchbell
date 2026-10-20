// B6: the free-tier limits the Budget tab compares against, saved in ops.settings "budget.limits". The defaults are the
// published free plans as last checked (lib/view/settings.ts); the owner corrects them here when a provider changes a
// plan, without a deploy. Display only: no collector or alert threshold reads these.
export type BudgetLimits = {
  qstashPerDay: number; webAnalyticsEvents: number; vercelInvocations: number; vercelCpuHours: number; vercelMemoryGbH: number;
  warnPct: number; errPct: number;
};

export const BUDGET_SETTING = "budget.limits";

export const BUDGET_DEFAULTS: BudgetLimits = {
  qstashPerDay: 1000, webAnalyticsEvents: 50_000, vercelInvocations: 1_000_000, vercelCpuHours: 4, vercelMemoryGbH: 360, warnPct: 70, errPct: 90,
};

export const BUDGET_FIELDS: { key: keyof BudgetLimits; label: string; unit: string; min: number; max: number }[] = [
  { key: "qstashPerDay", label: "Upstash QStash messages", unit: "a day", min: 1, max: 10_000_000 },
  { key: "webAnalyticsEvents", label: "Vercel Web Analytics events", unit: "a month", min: 1, max: 100_000_000 },
  { key: "vercelInvocations", label: "Vercel function invocations", unit: "a month", min: 1, max: 1_000_000_000 },
  { key: "vercelCpuHours", label: "Vercel active CPU", unit: "hours a month", min: 1, max: 10_000 },
  { key: "vercelMemoryGbH", label: "Vercel provisioned memory", unit: "GB-hours a month", min: 1, max: 100_000 },
  { key: "warnPct", label: "Warn from", unit: "% used", min: 10, max: 99 },
  { key: "errPct", label: "Alarm from", unit: "% used", min: 11, max: 100 },
];

const inRange = (f: (typeof BUDGET_FIELDS)[number], v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max;

export function parseBudget(raw: unknown): BudgetLimits {
  const out = { ...BUDGET_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const f of BUDGET_FIELDS) {
    const v = (raw as Record<string, unknown>)[f.key];
    if (inRange(f, v)) out[f.key] = v;
  }
  return out.warnPct < out.errPct ? out : { ...out, warnPct: BUDGET_DEFAULTS.warnPct, errPct: BUDGET_DEFAULTS.errPct };
}

export function validateBudget(input: unknown): { ok: true; value: BudgetLimits } | { ok: false; error: string; fieldErrors: Record<string, string> } {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const value = { ...BUDGET_DEFAULTS };
  const fieldErrors: Record<string, string> = {};
  for (const f of BUDGET_FIELDS) {
    const raw = src[f.key];
    const v = typeof raw === "string" ? Number(raw.replace(/[,_\s]/g, "")) : raw;
    if (inRange(f, v)) value[f.key] = v;
    else fieldErrors[f.key] = `Enter a whole number from ${f.min.toLocaleString("en-US")} to ${f.max.toLocaleString("en-US")}.`;
  }
  if (!fieldErrors.warnPct && !fieldErrors.errPct && value.warnPct >= value.errPct) fieldErrors.errPct = "Alarm must be above Warn.";
  return Object.keys(fieldErrors).length ? { ok: false, error: "Check the highlighted fields.", fieldErrors } : { ok: true, value };
}

export function budgetChanges(before: BudgetLimits, after: BudgetLimits): string | null {
  const list = BUDGET_FIELDS.filter((f) => before[f.key] !== after[f.key]).map((f) => `${f.label} ${before[f.key].toLocaleString("en-US")} → ${after[f.key].toLocaleString("en-US")}`);
  return list.length ? list.join(", ") : null;
}
