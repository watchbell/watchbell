import { computeLine, type ComputeValues, connPct, FRESH_MS, hourSeries, hourStart, type HourRow, type MetricsLatest } from "@/lib/databases/compute-metrics";
import { d1Shares, type Share, tursoShares, upstashShares } from "@/lib/databases/extra";
import { FIRESTORE_FREE, FIRESTORE_USAGE_STORAGE, quotaDayStart } from "@/lib/databases/firebase";
import { NEON_FREE } from "@/lib/databases/neon";
import { d1Data, firebaseData, neonData, readData, supabaseData, tursoData, upstashData } from "@/lib/databases/snapshot-data";
import { FREE_DB_BYTES } from "@/lib/databases/supabase";
import type { DbRow } from "@/lib/data/databases-db";
import type { State } from "@/lib/status";
import { ago, clock } from "@/lib/time";
import { type AliasBook, dbAlias, EMPTY_BOOK } from "./display-name";

// Stage 12: usage and compute of the watched databases, every number with where it comes from.
//   Supabase  compute (CPU, RAM, disk, connections) from the Metrics API with the owner's per-project key; database
//             size vs 500 MB from the Management API (daily). Egress and MAU have no per-project Management API
//             endpoint, so they are named "not readable" with where to look.
//   Neon      CU-hours, active time, storage and transfer vs the free plan, from the Neon API project object.
//   Firestore reads / writes / deletes today vs the Spark quotas, from Cloud Monitoring (Blaze only: Spark answers 403
//             "requires billing"); storage (1 GiB) isn't read on any plan.
// Pure.

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (used: number, limit: number) => round1((used / limit) * 100);

// ---- the Supabase page's Compute panel ----

export type ComputeRead = {
  latest: MetricsLatest | null; lastTryAt: Date | null; lastOkAt: Date | null; lastError: string | null; hours: ({ hour: Date } & HourRow)[];
};

export type Gauge = { label: string; value: string; pct: number | null; tone?: "warn" | "err"; series: (number | null)[]; peak: string | null };
// Owner 13 Nov, as Supabase's Observability › Database shows memory: what RAM holds now, 24 hourly stacks of used,
// cache + buffers and swap against total RAM, and the memory commitment of its limit.
export type MemoryView = {
  now: { total: string; used: string; cache: string; swap: string | null };
  parts: string[]; max: number; bars: { key: string; title: string; values: number[] }[];
};
export type CommitView = { value: string; pct: number; tone?: "warn" | "err"; series: (number | null)[]; peak: string | null; note: string | null };
export type ComputePanel =
  | { kind: "none" }
  | { kind: "waiting"; note: string }
  | { kind: "ok"; gauges: Gauge[]; asOf: string; stale: boolean; error: string | null; memory: MemoryView | null; commit: CommitView | null };

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
// Memory the way Supabase writes it: whole MB under a GB, two decimals above.
export const memText = (n: number): string => (n >= GIB ? `${(n / GIB).toFixed(2)} GB` : `${Math.round(n / MIB)} MB`);
const HOUR_MS = 3_600_000;

function memoryView(l: MetricsLatest, hours: ({ hour: Date } & HourRow)[], now: Date): MemoryView | null {
  const m = l.mem;
  if (!m) return null;
  const end = hourStart(now).getTime();
  const at = new Map(hours.map((h) => [h.hour.getTime(), h]));
  const bars = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(end - (23 - i) * HOUR_MS);
    const h = at.get(start.getTime());
    const values = [h?.memUsedB ?? 0, h?.memCacheB ?? 0, h?.swapB ?? 0];
    const total = h?.memTotalB ?? m.totalB;
    const title = h && h.memUsedB !== null && h.memUsedB !== undefined
      ? `${clock(start)} · used ${memText(values[0])}, cache + buffers ${memText(values[1])}, swap ${memText(values[2])} of ${memText(total)}`
      : `${clock(start)} · no data`;
    return { key: start.toISOString(), title, values };
  });
  return {
    now: { total: memText(m.totalB), used: memText(m.usedB), cache: memText(m.cacheB), swap: m.swapB === null ? null : memText(m.swapB) },
    parts: ["Used", "Cache + Buffers", "Swap"], max: m.totalB, bars,
  };
}

// Warns from 85 % (Supabase marked 89 % WARNING on 13 Nov). Owner 13 Nov (1.7.1): past 100 % alone is still a
// warning (overcommit is normal on small instances); Critical only when the server is really short of memory: swap
// at half the RAM or more, or RAM 95 % used. The note says which, and what helps.
const SWAP_CRITICAL = 0.5;
const RAM_CRITICAL = 95;
const MEMORY_HELP = "Use the pooler (port 6543), smaller connection pools, turn off unused services (Realtime, Data API), or Restart the project.";

function commitView(l: MetricsLatest, hours: ({ hour: Date } & HourRow)[], now: Date): CommitView | null {
  const c = l.commit;
  if (!c) return null;
  const series = hourSeries(hours.map((h) => ({ ...h, commitPct: h.commitPct ?? null })), "commitPct", now);
  const peaks = hourSeries(hours.map((h) => ({ ...h, commitMax: h.commitMax ?? null })), "commitMax", now);
  const m = l.mem;
  const swapShort = !!m && m.swapB !== null && m.totalB > 0 && m.swapB >= SWAP_CRITICAL * m.totalB;
  const ramShort = l.memPct !== null && l.memPct >= RAM_CRITICAL;
  let tone: CommitView["tone"] = c.pct >= 85 ? "warn" : undefined;
  let note: string | null = c.pct >= 100 ? "Overcommitted: normal on small instances while swap stays low." : null;
  if (swapShort && m) {
    tone = "err";
    note = `Swap is ${memText(m.swapB as number)} of ${memText(m.totalB)} RAM: queries slow down. ${MEMORY_HELP}`;
  } else if (ramShort) {
    tone = "err";
    note = `RAM is ${Math.round(l.memPct as number)}% used: the database may restart when it runs out. ${MEMORY_HELP}`;
  }
  return { value: `${memText(c.usedB)} of ${memText(c.limitB)}`, pct: c.pct, tone, series, peak: peakOf(peaks), note };
}

const tone = (p: number | null, warnAt: number): Gauge["tone"] => (p === null ? undefined : p >= 95 ? "err" : p >= warnAt ? "warn" : undefined);
const pctText = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);
const peakOf = (xs: (number | null)[]) => {
  const nums = xs.filter((x): x is number => x !== null);
  return nums.length ? `${Math.round(Math.max(...nums))}% peak 24 h` : null;
};

export function computePanel(read: ComputeRead | undefined, now: Date): ComputePanel {
  if (!read) return { kind: "none" };
  const l = read.latest;
  if (!l) {
    return { kind: "waiting", note: read.lastError ? `Last try ${read.lastTryAt ? ago(read.lastTryAt, now) : "—"}: ${read.lastError}` : "Waiting for the first scrape (with the next collector run)." };
  }
  const series = <K extends keyof HourRow>(k: K) => hourSeries(read.hours, k, now);
  const cpu = series("cpuAvg");
  const mem = series("memAvg");
  const disk = series("diskPct");
  const conn = read.hours.length ? hourSeries(read.hours.map((h) => ({ ...h, connUsed: h.connUsed !== null && h.connMax ? round1((h.connUsed / h.connMax) * 100) : null })), "connUsed", now) : [];
  const c = connPct(l);
  const gauges: Gauge[] = [
    { label: "CPU", value: l.cpuPct === null ? "—" : pctText(l.cpuPct), pct: l.cpuPct, tone: tone(l.cpuPct, 80), series: cpu, peak: peakOf(series("cpuMax")) },
    { label: "RAM", value: pctText(l.memPct), pct: l.memPct, tone: tone(l.memPct, 90), series: mem, peak: peakOf(series("memMax")) },
    { label: "Disk", value: pctText(l.diskPct), pct: l.diskPct, tone: tone(l.diskPct, 80), series: disk, peak: null },
    { label: "Connections", value: l.connUsed === null ? "—" : `${l.connUsed}${l.connMax ? ` / ${l.connMax}` : ""}`, pct: c, tone: tone(c, 80), series: conn, peak: null },
  ];
  const stale = now.getTime() - new Date(l.at).getTime() > FRESH_MS;
  return {
    kind: "ok", gauges, asOf: ago(new Date(l.at), now), stale, error: read.lastError,
    memory: memoryView(l, read.hours, now), commit: commitView(l, read.hours, now),
  };
}

// ---- the cross-provider overview (Databases → Free databases) ----

export type UsageSource = "metrics" | "api" | "monitoring" | "graphql";
export type UsageRow = {
  id: string; name: string; alias: string; provider: "Supabase" | "Neon" | "Firestore" | "Turso" | "Upstash" | "D1"; href: string; state: State;
  main: { label: string; pct: number | null; text: string } | null; source: UsageSource; asOf: string | null;
  extra: string[]; note: string | null;
};

// The highest of a database's quota shares is its "main % used".
const top = (xs: { label: string; pct: number | null; text: string }[]) =>
  xs.filter((x) => x.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null;

const NOT_READABLE_SUPABASE = "Egress and MAU: not readable, the Management API has no per-project endpoint for them (Supabase dashboard → Usage).";

export function usageRows(
  input: {
    supabase: DbRow[]; neon: DbRow[]; firestore: DbRow[]; compute: Map<string, Pick<ComputeRead, "latest">>;
    // Stage 8 (optional, so older callers keep working)
    turso?: DbRow[]; upstash?: DbRow[]; d1?: DbRow[];
  },
  now: Date, book: AliasBook = EMPTY_BOOK,
): UsageRow[] {
  const out: UsageRow[] = [];
  for (const r of input.supabase) {
    const d = readData(supabaseData, r.data);
    const size = d.sizeBytes != null ? { label: "Database size", pct: pct(d.sizeBytes, FREE_DB_BYTES), text: "of 500 MB" } : null;
    const l = input.compute.get(r.id)?.latest ?? null;
    const fresh = l && now.getTime() - new Date(l.at).getTime() <= FRESH_MS ? l : null;
    const comp = fresh ? computeShares(fresh) : [];
    const main = top([...(size ? [size] : []), ...comp]);
    const fromMetrics = !!main && main.label !== "Database size";
    out.push({
      id: r.id, name: r.name, alias: dbAlias(book, r.id), provider: "Supabase", href: "/supabase", state: r.state, main,
      source: fromMetrics ? "metrics" : "api",
      asOf: fromMetrics && fresh ? ago(new Date(fresh.at), now) : d.sizeAt ? ago(new Date(d.sizeAt), now) : null,
      extra: [
        ...(size && fromMetrics ? [`DB ${Math.round(size.pct ?? 0)}% of 500 MB`] : []),
        ...comp.filter((c) => c !== main).map((c) => `${c.label} ${Math.round(c.pct ?? 0)}%`),
      ],
      note: !input.compute.has(r.id) ? `No metrics key: CPU and RAM not read. ${NOT_READABLE_SUPABASE}` : NOT_READABLE_SUPABASE,
    });
  }
  for (const r of input.neon) {
    const d = readData(neonData, r.data);
    const storage = (d.branches ?? []).reduce((n, b) => n + (b.logicalSize ?? 0), 0);
    const shares = [
      ...(d.computeSeconds != null ? [{ label: "Compute", pct: pct(d.computeSeconds / 3600, NEON_FREE.cuHours), text: `of ${NEON_FREE.cuHours} CU-h` }] : []),
      ...(d.branches ? [{ label: "Storage", pct: pct(storage, NEON_FREE.storageBytes), text: "of 1 GB" }] : []),
      ...(d.transferBytes != null ? [{ label: "Transfer", pct: pct(d.transferBytes, NEON_FREE.transferBytes), text: "of 5 GB" }] : []),
    ];
    const main = top(shares);
    out.push({
      id: r.id, name: r.name, alias: dbAlias(book, r.id), provider: "Neon", href: "/neon", state: r.state, main, source: "api",
      asOf: r.collectedAt ? ago(r.collectedAt, now) : null,
      extra: [
        ...shares.filter((s) => s !== main).map((s) => `${s.label} ${Math.round(s.pct ?? 0)}%`),
        ...(d.activeSeconds != null ? [`active ${round1(d.activeSeconds / 3600)} h this month`] : []),
      ],
      note: null,
    });
  }
  for (const r of input.firestore) {
    const d = readData(firebaseData, r.data);
    const opsAt = d.opsAt ? new Date(d.opsAt) : null;
    const today = opsAt && opsAt.getTime() >= quotaDayStart(now).getTime();
    const shares = today ? [
      ...(d.reads != null ? [{ label: "Reads today", pct: pct(d.reads, FIRESTORE_FREE.reads), text: "of 50k" }] : []),
      ...(d.writes != null ? [{ label: "Writes today", pct: pct(d.writes, FIRESTORE_FREE.writes), text: "of 20k" }] : []),
      ...(d.deletes != null ? [{ label: "Deletes today", pct: pct(d.deletes, FIRESTORE_FREE.deletes), text: "of 20k" }] : []),
    ] : [];
    const main = top(shares);
    out.push({
      id: r.id, name: r.name, alias: dbAlias(book, r.id), provider: "Firestore", href: "/firebase", state: r.state, main, source: "monitoring",
      asOf: opsAt ? ago(opsAt, now) : null,
      extra: shares.filter((s) => s !== main).map((s) => `${s.label.replace(" today", "")} ${Math.round(s.pct ?? 0)}%`),
      note: d.opsError ?? (main ? FIRESTORE_USAGE_STORAGE : "No usage read today yet."),
    });
  }
  // Stage 8: the same shares the Turso, Upstash and D1 pages show (lib/databases/extra.ts).
  const extra = (rows: DbRow[] | undefined, provider: "Turso" | "Upstash" | "D1", href: string, source: UsageSource,
    shares: (d: unknown) => Share[], at: (d: unknown) => string | null | undefined, note: (d: unknown, has: boolean) => string | null) => {
    for (const r of rows ?? []) {
      const sh = shares(r.data);
      const main = top(sh);
      const when = at(r.data);
      out.push({
        id: r.id, name: r.name, alias: dbAlias(book, r.id), provider, href, state: r.state, main, source,
        asOf: when ? ago(new Date(when), now) : null,
        extra: sh.filter((s) => s !== main).map((s) => `${s.label} ${Math.round(s.pct ?? 0)}%`),
        note: note(r.data, main !== null),
      });
    }
  };
  extra(input.turso, "Turso", "/turso", "api", (x) => tursoShares(readData(tursoData, x), now), (x) => readData(tursoData, x).usageAt,
    (x) => readData(tursoData, x).usageError ?? "Turso's free limits are per organization: the shares are the organization's.");
  extra(input.upstash, "Upstash", "/upstash", "api", (x) => upstashShares(readData(upstashData, x), now), (x) => readData(upstashData, x).statsAt,
    (x, has) => readData(upstashData, x).statsError ?? (has ? null : "No stats read this month yet."));
  extra(input.d1, "D1", "/d1", "graphql", (x) => d1Shares(readData(d1Data, x), now), (x) => readData(d1Data, x).usageAt ?? readData(d1Data, x).detailsAt,
    (x) => readData(d1Data, x).usageError ?? "Rows read and written are the Cloudflare account's today (UTC).");
  return out;
}

function computeShares(l: ComputeValues): { label: string; pct: number | null; text: string }[] {
  return [
    { label: "CPU", pct: l.cpuPct, text: "busy" },
    { label: "RAM", pct: l.memPct, text: "used" },
    { label: "Disk", pct: l.diskPct, text: "used" },
    { label: "Connections", pct: connPct(l), text: "of max" },
  ].filter((x) => x.pct !== null);
}

// The patrol's per-database usage phrase (Indonesian, like the rest of the room text), keyed by alias.
export function usagePhrases(rows: UsageRow[], compute: Map<string, Pick<ComputeRead, "latest">>, now: Date): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const bits: string[] = [];
    const l = compute.get(r.id)?.latest;
    if (r.provider === "Supabase" && l && now.getTime() - new Date(l.at).getTime() <= FRESH_MS) {
      bits.push(computeLine(l));
    }
    if (r.main && !(r.provider === "Supabase" && r.source === "metrics")) bits.push(`${r.main.label} ${Math.round(r.main.pct ?? 0)} % ${r.main.text}`);
    else if (r.main === null && r.provider !== "Supabase" && r.note) bits.push("quota unreadable");
    const s = bits.filter(Boolean).join("; ");
    if (s) out.set(r.alias, s);
  }
  return out;
}
