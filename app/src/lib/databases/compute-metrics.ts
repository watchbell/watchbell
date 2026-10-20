// Stage 12: compute of a Supabase project (CPU, RAM, disk, connections) from Supabase's Metrics API, beta on hosted
// projects (supabase.com/docs/guides/observability/metrics): GET https://<ref>.supabase.co/customer/v1/privileged/metrics,
// Prometheus text, Basic Auth `service_role` + a Secret API key (sb_secret_…) the owner pastes per project. Metric
// names as Supabase's own Grafana dashboard reads them (github.com/supabase/supabase-grafana, checked 16 Oct 2026):
//   CPU         100 − idle share of rate(node_cpu_seconds_total)   → a counter: the % comes from two scrapes' delta
//   RAM         1 − node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
//   disk        1 − node_filesystem_avail_bytes / node_filesystem_size_bytes (the database volume /data, else /)
//   connections pg_stat_database_num_backends (summed over databases) vs pg_settings_max_connections
// Pure: parsing, the CPU delta, the hourly rollup, the ComputeHigh limits and the 5-minute throttle.

export type PromSample = { name: string; labels: Record<string, string>; value: number };

const LINE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)(?:\s+-?\d+)?\s*$/;

function parseValue(s: string): number {
  if (s === "NaN") return Number.NaN;
  if (s === "+Inf" || s === "Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  return Number(s);
}

// `{a="x",b="y\"z"}` → { a: "x", b: "y\"z" }; null when it isn't a well-formed label set.
function parseLabels(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = 1;
  const end = raw.length - 1;
  while (i < end) {
    while (i < end && (raw[i] === "," || raw[i] === " ")) i++;
    if (i >= end) break;
    const eq = raw.indexOf("=", i);
    if (eq < 0) return null;
    const key = raw.slice(i, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || raw[eq + 1] !== "\"") return null;
    let j = eq + 2;
    let val = "";
    for (; j < end; j++) {
      const c = raw[j];
      if (c === "\\") {
        const n = raw[j + 1];
        val += n === "n" ? "\n" : n;
        j++;
      } else if (c === "\"") break;
      else val += c;
    }
    if (raw[j] !== "\"") return null;
    out[key] = val;
    i = j + 1;
  }
  return out;
}

// Prometheus text exposition (0.0.4). Comments, blank lines and malformed lines are skipped, never thrown.
export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const labels = m[2] ? parseLabels(m[2]) : {};
    if (!labels) continue;
    const value = parseValue(m[3]);
    if (Number.isNaN(value) && m[3] !== "NaN") continue;
    out.push({ name: m[1], labels, value });
  }
  return out;
}

// The raw numbers of one scrape. cpu: summed counters over every CPU (seconds); null where a metric is missing.
export type RawSample = {
  cpu: { busy: number; total: number } | null; memTotal: number | null; memAvailable: number | null;
  diskSize: number | null; diskAvail: number | null; backends: number | null; maxConnections: number | null;
};

const finite = (n: number) => Number.isFinite(n);
const sum = (xs: PromSample[]) => (xs.length ? xs.reduce((n, s) => n + s.value, 0) : null);
const MAX_CONN_NAMES = ["pg_settings_max_connections", "pg_max_connections"];
const SKIP_FS = new Set(["rootfs", "tmpfs", "overlay", "squashfs", "devtmpfs"]);

// A project with read replicas reports one series per database server (label supabase_identifier). The primary's
// identifier is the project ref; without that label (or no series for the ref) every series is used.
export function extractSample(samples: PromSample[], ref?: string): RawSample {
  const own = ref && samples.some((s) => s.labels.supabase_identifier === ref)
    ? samples.filter((s) => s.labels.supabase_identifier === undefined || s.labels.supabase_identifier === ref) : samples;
  const of = (name: string) => own.filter((s) => s.name === name && finite(s.value));
  const cpus = of("node_cpu_seconds_total");
  const total = sum(cpus);
  const idle = sum(cpus.filter((s) => s.labels.mode === "idle"));
  const first = (name: string) => of(name)[0]?.value ?? null;
  const fs = (name: string) => {
    const xs = of(name).filter((s) => !SKIP_FS.has(s.labels.fstype ?? ""));
    return (xs.find((s) => s.labels.mountpoint === "/data") ?? xs.find((s) => s.labels.mountpoint === "/") ?? null)?.value ?? null;
  };
  return {
    cpu: total !== null && idle !== null ? { busy: total - idle, total } : null,
    memTotal: first("node_memory_MemTotal_bytes"), memAvailable: first("node_memory_MemAvailable_bytes"),
    diskSize: fs("node_filesystem_size_bytes"), diskAvail: fs("node_filesystem_avail_bytes"),
    backends: sum(of("pg_stat_database_num_backends")),
    maxConnections: MAX_CONN_NAMES.map(first).find((v) => v !== null) ?? null,
  };
}

export type CpuMark = { at: string; busy: number; total: number };
// A delta over a longer gap than this is an average of hours, not "now": no CPU value then.
export const CPU_MAX_GAP_MS = 30 * 60_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.min(100, Math.max(0, n));

// CPU busy % between two scrapes of the counters. Null on the first scrape, a counter reset (restart), no time
// between them or a gap longer than CPU_MAX_GAP_MS.
export function cpuPct(prev: CpuMark | null | undefined, cur: CpuMark | null): number | null {
  if (!prev || !cur) return null;
  const gap = new Date(cur.at).getTime() - new Date(prev.at).getTime();
  if (!(gap > 0) || gap > CPU_MAX_GAP_MS) return null;
  const dTotal = cur.total - prev.total;
  const dBusy = cur.busy - prev.busy;
  if (dTotal <= 0 || dBusy < 0) return null;
  return round1(clampPct((dBusy / dTotal) * 100));
}

export type ComputeValues = { cpuPct: number | null; memPct: number | null; diskPct: number | null; connUsed: number | null; connMax: number | null };

const share = (used: number | null, total: number | null) => (used !== null && total !== null && total > 0 ? round1(clampPct((used / total) * 100)) : null);

export function computeValues(raw: RawSample, prev: CpuMark | null | undefined, at: string): ComputeValues {
  const cur = raw.cpu ? { at, ...raw.cpu } : null;
  return {
    cpuPct: cpuPct(prev, cur),
    memPct: raw.memTotal !== null && raw.memAvailable !== null ? share(raw.memTotal - raw.memAvailable, raw.memTotal) : null,
    diskPct: raw.diskSize !== null && raw.diskAvail !== null ? share(raw.diskSize - raw.diskAvail, raw.diskSize) : null,
    connUsed: raw.backends === null ? null : Math.round(raw.backends),
    connMax: raw.maxConnections === null ? null : Math.round(raw.maxConnections),
  };
}

export const connPct = (v: Pick<ComputeValues, "connUsed" | "connMax">): number | null => share(v.connUsed, v.connMax);

// What ops.supabase_metrics_keys.latest keeps: the newest values, the counters for the next CPU delta and the CPU of the
// last few scrapes (for "CPU > x % for 15 min").
export type RecentCpu = { at: string; cpu: number };
export type MetricsLatest = ComputeValues & { at: string; prev: CpuMark | null; recent: RecentCpu[] };
export const RECENT_KEEP_MS = 40 * 60_000;

export function nextLatest(before: MetricsLatest | null, raw: RawSample, now: Date): MetricsLatest {
  const at = now.toISOString();
  const v = computeValues(raw, before?.prev, at);
  const recent = (before?.recent ?? []).filter((r) => now.getTime() - new Date(r.at).getTime() <= RECENT_KEEP_MS);
  if (v.cpuPct !== null) recent.push({ at, cpu: v.cpuPct });
  return { ...v, at, prev: raw.cpu ? { at, ...raw.cpu } : null, recent: recent.slice(-8) };
}

// ---- hourly rollups (ops.supabase_metrics) ----

export type HourRow = {
  samples: number; cpuSamples: number; cpuAvg: number | null; cpuMax: number | null; memAvg: number | null; memMax: number | null;
  diskPct: number | null; connUsed: number | null; connMax: number | null;
};

export const hourStart = (d: Date): Date => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

const avg = (a: number | null, n: number, v: number | null) => (v === null ? a : a === null || n === 0 ? v : round1((a * n + v) / (n + 1)));
const max = (a: number | null, v: number | null) => (v === null ? a : a === null ? v : Math.max(a, v));

// One scrape into its hour: averages and peaks for CPU and RAM, the newest disk %, the peak connections.
export function mergeHour(row: HourRow | null, v: ComputeValues): HourRow {
  const r: HourRow = row ?? { samples: 0, cpuSamples: 0, cpuAvg: null, cpuMax: null, memAvg: null, memMax: null, diskPct: null, connUsed: null, connMax: null };
  const memN = r.memAvg === null ? 0 : r.samples;
  return {
    samples: r.samples + 1,
    cpuSamples: r.cpuSamples + (v.cpuPct === null ? 0 : 1),
    cpuAvg: avg(r.cpuAvg, r.cpuSamples, v.cpuPct), cpuMax: max(r.cpuMax, v.cpuPct),
    memAvg: avg(r.memAvg, memN, v.memPct), memMax: max(r.memMax, v.memPct),
    diskPct: v.diskPct ?? r.diskPct,
    connUsed: max(r.connUsed, v.connUsed), connMax: v.connMax ?? r.connMax,
  };
}

export const RETENTION_DAYS = 3;

// 24 hourly points, oldest first, null where no hour row exists (a gap in the sparkline).
export function hourSeries<K extends keyof HourRow>(rows: ({ hour: Date } & HourRow)[], key: K, now: Date, hours = 24): (number | null)[] {
  const end = hourStart(now).getTime();
  const at = new Map(rows.map((r) => [r.hour.getTime(), r[key]]));
  return Array.from({ length: hours }, (_, i) => {
    const v = at.get(end - (hours - 1 - i) * 3_600_000);
    return typeof v === "number" ? v : null;
  });
}

// ---- ComputeHigh ----

// The rule's one editable threshold T (catalog ComputeHigh, default 80): CPU > T % for 15 min, disk > T %, connections
// > T % of max; RAM > T + 10 % (90 by default), since Postgres keeps most of the memory as cache.
export type ComputeLimits = { cpu: number; ram: number; disk: number; conn: number };
export const computeLimits = (t: number | null): ComputeLimits => {
  const x = t ?? 80;
  return { cpu: x, ram: Math.min(99, x + 10), disk: x, conn: x };
};

export const SUSTAIN_MS = 15 * 60_000;
// Latest values older than this say nothing about now (the scrape runs every 5 minutes).
export const FRESH_MS = 20 * 60_000;

export type ComputeFact = { id: string; name: string; latest: MetricsLatest | null };

// What crosses the limits now, as short phrases; null when the data can't judge it (no fresh scrape).
// CPU counts only when every scrape of the last 15 minutes (at least 3, spanning ≥ 10 min) is above the limit.
export function computeBreaches(latest: MetricsLatest | null, limits: ComputeLimits, now: Date): string[] | null {
  if (!latest || now.getTime() - new Date(latest.at).getTime() > FRESH_MS) return null;
  const out: string[] = [];
  const window = latest.recent.filter((r) => now.getTime() - new Date(r.at).getTime() <= SUSTAIN_MS + 60_000);
  const span = window.length ? new Date(window[window.length - 1].at).getTime() - new Date(window[0].at).getTime() : 0;
  if (window.length >= 3 && span >= 9 * 60_000 && window.every((r) => r.cpu > limits.cpu)) {
    out.push(`CPU ${Math.round(Math.min(...window.map((r) => r.cpu)))}%+ for 15 min (limit ${limits.cpu}%)`);
  }
  if (latest.memPct !== null && latest.memPct > limits.ram) out.push(`RAM ${Math.round(latest.memPct)}% (limit ${limits.ram}%)`);
  if (latest.diskPct !== null && latest.diskPct > limits.disk) out.push(`disk ${Math.round(latest.diskPct)}% (limit ${limits.disk}%)`);
  const c = connPct(latest);
  if (c !== null && c > limits.conn) out.push(`connections ${latest.connUsed} of ${latest.connMax} (limit ${limits.conn}%)`);
  return out;
}

// ---- the 5-minute throttle (same shape as the office's log reads, private/actions/log-proposals.ts logsDue) ----

export const SCRAPE_EVERY_MS = 5 * 60_000;

// Once per 5-minute clock slot per instance; a cold instance scrapes only in the slot's first minute (or when its own
// last scrape is two slots old), so several warm instances don't each scrape.
export function scrapeDue(now: Date, last: number | null): boolean {
  const t = now.getTime();
  if (last !== null && t - last < SCRAPE_EVERY_MS - 30_000) return false;
  return Math.floor(t / 60_000) % 5 === 0 || (last !== null && t - last >= SCRAPE_EVERY_MS * 2);
}

// The patrol's line, e.g. "CPU 12 %, RAM 41 %, disk 8 %, connections 9/60".
export function computeLine(v: Pick<ComputeValues, "cpuPct" | "memPct" | "diskPct" | "connUsed" | "connMax">): string {
  const p = (label: string, n: number | null) => (n === null ? null : `${label} ${Math.round(n)} %`);
  return [p("CPU", v.cpuPct), p("RAM", v.memPct), p("disk", v.diskPct), v.connUsed !== null ? `connections ${v.connUsed}${v.connMax ? `/${v.connMax}` : ""}` : null]
    .filter(Boolean).join(", ");
}
