// R8 (free tier): every page query is bounded. Pages read at most this many rows, over at most these windows.
export const PAGE_ROWS = { events: 200, deployments: 200, apps: 200, monitors: 200, domains: 200, databases: 200, recentEvents: 5, ongoingBuilds: 5 } as const;

export const WINDOWS = {
  rawChecksMs: 7 * 86_400_000, // raw checks are kept 7 days; older hours come from rollups_hourly
  healthBuckets: 30, // Overview → Health: 30 points over 24 h (48-minute buckets)
  metricBuckets: 48, // App → Metrics: 48 points over 24 h (30-minute buckets)
  responseHours: 24, // Applications → Response 24h: hourly p95
} as const;
