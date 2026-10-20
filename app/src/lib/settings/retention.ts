import { RETENTION_DAYS } from "@/lib/collector/retention";

// B6: the Owner's retention, saved in ops.settings "retention.days". Only fixed choices are accepted (the defaults are
// always one of them), so a typo can't empty a table or grow the database past the free 500 MB. The minimums keep a
// whole month for the monthly backup, which runs on the 1st before retention.
export type RetentionKey = keyof typeof RETENTION_DAYS;
export type RetentionDays = Record<RetentionKey, number>;

export const RETENTION_SETTING = "retention.days";

export const RETENTION_CHOICES: Record<RetentionKey, readonly number[]> = {
  checks: [3, 7, 14],
  rollupsHourly: [60, 90, 180],
  storedLogs: [3, 7, 14],
  deployments: [30, 45, 60, 90],
  events: [60, 90, 180],
  alerts: [60, 90, 180],
  collectorRuns: [7, 14, 30],
  recommendationDismissals: [30, 90, 180],
};

export const RETENTION_KEYS = Object.keys(RETENTION_CHOICES) as RetentionKey[];

export const RETENTION_LABEL: Record<RetentionKey, string> = {
  checks: "Raw checks", rollupsHourly: "Hourly rollups", storedLogs: "Stored logs", deployments: "Deployments", events: "Events",
  alerts: "Alerts", collectorRuns: "Collector runs", recommendationDismissals: "Advisor dismissals",
};

const allowed = (k: RetentionKey, v: unknown): v is number => typeof v === "number" && RETENTION_CHOICES[k].includes(v);

// What the daily job deletes by: the saved choices over the defaults. Anything unreadable keeps the default.
export function parseRetention(raw: unknown): RetentionDays {
  const out: RetentionDays = { ...RETENTION_DAYS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of RETENTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (allowed(k, v)) out[k] = v;
  }
  return out;
}

export function validateRetention(input: unknown): { ok: true; value: RetentionDays } | { ok: false; error: string; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const value: RetentionDays = { ...RETENTION_DAYS };
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const k of RETENTION_KEYS) {
    const v = typeof src[k] === "string" ? Number(src[k]) : src[k];
    if (allowed(k, v)) value[k] = v;
    else fieldErrors[k] = `Pick ${RETENTION_CHOICES[k].join(", ")} days.`;
  }
  return Object.keys(fieldErrors).length ? { ok: false, error: "Check the highlighted fields.", fieldErrors } : { ok: true, value };
}

// "Raw checks 7 → 14 days, Events 90 → 60 days" for the audit entry; null when nothing changed.
export function retentionChanges(before: RetentionDays, after: RetentionDays): string | null {
  const list = RETENTION_KEYS.filter((k) => before[k] !== after[k]).map((k) => `${RETENTION_LABEL[k]} ${before[k]} → ${after[k]} days`);
  return list.length ? list.join(", ") : null;
}
