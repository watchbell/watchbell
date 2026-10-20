// How long the daily job's retention step (daily.ts) keeps each of the console's own history tables, in days. The step
// and the Settings → Retention tab both read this, so the page can't drift from what is really deleted.
export const RETENTION_DAYS = {
  checks: 7,
  rollupsHourly: 90,
  deployments: 30,
  events: 90,
  alerts: 90,
  collectorRuns: 14,
  storedLogs: 7,
  recommendationDismissals: 90,
} as const;
