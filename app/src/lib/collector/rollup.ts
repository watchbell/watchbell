// Nearest-rank percentile on an ascending list.
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

// U5: checks inside a maintenance window are counted apart (`maintenance`) and left out of everything else.
export function rollup(rows: { ok: boolean; statusCode: number | null; latencyMs: number | null; inMaintenance?: boolean }[]) {
  const counted = rows.filter((r) => !r.inMaintenance);
  const lat = counted.map((r) => r.latencyMs).filter((n): n is number => n !== null).sort((a, b) => a - b);
  return {
    checks: counted.length,
    failures: counted.filter((r) => !r.ok).length,
    p50Ms: percentile(lat, 0.5),
    p95Ms: percentile(lat, 0.95),
    maxMs: lat.length ? lat[lat.length - 1] : null,
    status5xx: counted.filter((r) => r.statusCode !== null && r.statusCode >= 500).length,
    maintenance: rows.length - counted.length,
  };
}

export function hourStart(d: Date): Date {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h;
}

const HOUR = 3_600_000;
const RAW_RETENTION_MS = 7 * 24 * HOUR;

// Where the daily rollup starts: an hour before the latest hour already rolled up (redoing the last ones as a margin),
// but never further back than the raw checks are kept. With no rollups yet, the whole retention window.
export function rollupSince(latestHour: Date | null, now: Date): Date {
  const floor = hourStart(now).getTime() - RAW_RETENTION_MS;
  return new Date(Math.max(floor, latestHour ? latestHour.getTime() - HOUR : floor));
}
