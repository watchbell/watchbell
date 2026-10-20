import { describe, expect, it } from "vitest";
import {
  computeBreaches, computeLimits, computeLine, computeValues, connPct, cpuPct, extractSample, hourSeries, hourStart, type HourRow, mergeHour,
  type MetricsLatest, nextLatest, parsePrometheus, scrapeDue,
} from "./compute-metrics";

const REF = "abcdefghijklmnopqrst";

// The shape of the Metrics API's answer (names as Supabase's Grafana dashboard reads them); numbers made up.
const scrape = (idle0: number, user0: number, idle1: number, user1: number, extra = "") => `# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle",service_type="db",supabase_project_ref="${REF}",supabase_identifier="${REF}"} ${idle0}
node_cpu_seconds_total{cpu="0",mode="user",service_type="db",supabase_project_ref="${REF}",supabase_identifier="${REF}"} ${user0}
node_cpu_seconds_total{cpu="0",mode="iowait",supabase_identifier="${REF}"} 0
node_cpu_seconds_total{cpu="1",mode="idle",supabase_identifier="${REF}"} ${idle1}
node_cpu_seconds_total{cpu="1",mode="user",supabase_identifier="${REF}"} ${user1}
node_cpu_seconds_total{cpu="0",mode="idle",supabase_identifier="${REF}-rr-ap-1"} 99999
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes{supabase_identifier="${REF}"} 1e+09
node_memory_MemAvailable_bytes{supabase_identifier="${REF}"} 6.0e+08
node_filesystem_size_bytes{device="/dev/root",fstype="ext4",mountpoint="/",supabase_identifier="${REF}"} 10000
node_filesystem_avail_bytes{device="/dev/root",fstype="ext4",mountpoint="/",supabase_identifier="${REF}"} 9000
node_filesystem_size_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data",supabase_identifier="${REF}"} 8000
node_filesystem_avail_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data",supabase_identifier="${REF}"} 6000
node_filesystem_size_bytes{fstype="tmpfs",mountpoint="/data",supabase_identifier="${REF}"} 1
pg_stat_database_num_backends{datname="postgres",supabase_identifier="${REF}"} 7
pg_stat_database_num_backends{datname="template1",supabase_identifier="${REF}"} 2
pg_settings_max_connections{server="localhost:5432",supabase_identifier="${REF}"} 60
${extra}`;

describe("parsePrometheus", () => {
  it("reads names, labels (with escapes) and values; skips comments, blanks and broken lines", () => {
    const s = parsePrometheus([
      "# HELP x y", "", "up 1", 'a{b="c\\"d",e="f\\\\g"} 2.5 1700000000000', "nan_metric NaN", "inf_metric +Inf",
      "bad line here", 'broken{b="c} 1', "1starts_with_digit 3", "no_value{}",
    ].join("\n"));
    expect(s).toEqual([
      { name: "up", labels: {}, value: 1 },
      { name: "a", labels: { b: 'c"d', e: "f\\g" }, value: 2.5 },
      { name: "nan_metric", labels: {}, value: Number.NaN },
      { name: "inf_metric", labels: {}, value: Number.POSITIVE_INFINITY },
    ]);
  });

  it("handles CRLF and an empty body", () => {
    expect(parsePrometheus("up 1\r\nx 2\r\n")).toEqual([{ name: "up", labels: {}, value: 1 }, { name: "x", labels: {}, value: 2 }]);
    expect(parsePrometheus("")).toEqual([]);
  });
});

describe("extractSample", () => {
  it("sums the CPU counters of the primary only, picks /data over /, sums backends and reads max_connections", () => {
    const raw = extractSample(parsePrometheus(scrape(100, 20, 90, 30)), REF);
    expect(raw).toEqual({ cpu: { busy: 50, total: 240 }, memTotal: 1e9, memAvailable: 6e8, diskSize: 8000, diskAvail: 6000, backends: 9, maxConnections: 60 });
  });

  it("uses every series when the ref isn't among the identifiers, and gives null for missing metrics", () => {
    const raw = extractSample(parsePrometheus('node_cpu_seconds_total{cpu="0",mode="idle"} 10\nnode_cpu_seconds_total{cpu="0",mode="system"} 5'), REF);
    expect(raw).toEqual({ cpu: { busy: 5, total: 15 }, memTotal: null, memAvailable: null, diskSize: null, diskAvail: null, backends: null, maxConnections: null });
  });

  it("falls back to / when there is no /data volume", () => {
    const raw = extractSample(parsePrometheus('node_filesystem_size_bytes{fstype="ext4",mountpoint="/"} 100\nnode_filesystem_avail_bytes{fstype="ext4",mountpoint="/"} 25'));
    expect([raw.diskSize, raw.diskAvail]).toEqual([100, 25]);
  });
});

describe("cpuPct (counter deltas)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 10, min)).toISOString();
  it("is the busy share of the time between two scrapes", () => {
    expect(cpuPct({ at: at(0), busy: 50, total: 240 }, { at: at(5), busy: 110, total: 840 })).toBe(10);
    expect(cpuPct({ at: at(0), busy: 0, total: 0 }, { at: at(5), busy: 300, total: 300 })).toBe(100);
  });
  it("is null without a previous scrape, after a counter reset, with no time between or a gap over 30 min", () => {
    const cur = { at: at(5), busy: 10, total: 100 };
    expect(cpuPct(null, cur)).toBeNull();
    expect(cpuPct({ at: at(0), busy: 50, total: 500 }, cur)).toBeNull();
    expect(cpuPct({ at: at(0), busy: 20, total: 50 }, cur)).toBeNull(); // busy went down: reset
    expect(cpuPct({ at: at(5), busy: 1, total: 10 }, cur)).toBeNull();
    expect(cpuPct({ at: new Date(Date.UTC(2026, 9, 16, 9, 30)).toISOString(), busy: 1, total: 10 }, cur)).toBeNull();
    expect(cpuPct({ at: at(0), busy: 1, total: 10 }, null)).toBeNull();
  });
});

describe("computeValues and nextLatest", () => {
  it("turns a scrape into percentages; CPU needs the previous counters", () => {
    const t0 = new Date("2026-10-16T10:00:00Z");
    const first = nextLatest(null, extractSample(parsePrometheus(scrape(100, 20, 90, 30)), REF), t0);
    expect(first).toMatchObject({ cpuPct: null, memPct: 40, diskPct: 25, connUsed: 9, connMax: 60, recent: [], prev: { busy: 50, total: 240 } });
    const t1 = new Date("2026-10-16T10:05:00Z");
    // cpu0: idle +240, user +60; cpu1: idle +240, user +60 → busy 120 of 600 = 20 %
    const second = nextLatest(first, extractSample(parsePrometheus(scrape(340, 80, 330, 90)), REF), t1);
    expect(second.cpuPct).toBe(20);
    expect(second.recent).toEqual([{ at: t1.toISOString(), cpu: 20 }]);
    expect(connPct(second)).toBe(15);
  });

  it("drops recent CPU values older than 40 minutes and keeps at most 8", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const old: MetricsLatest = {
      at: "2026-10-16T11:55:00Z", cpuPct: 1, memPct: 1, diskPct: 1, connUsed: 1, connMax: 1, prev: null,
      recent: [{ at: "2026-10-16T11:00:00Z", cpu: 99 }, ...Array.from({ length: 9 }, (_, i) => ({ at: `2026-10-16T11:${String(30 + i).padStart(2, "0")}:00Z`, cpu: i }))],
    };
    const next = nextLatest(old, { cpu: null, memTotal: null, memAvailable: null, diskSize: null, diskAvail: null, backends: null, maxConnections: null }, now);
    expect(next.recent).toHaveLength(8);
    expect(next.recent.some((r) => r.cpu === 99)).toBe(false);
    expect(next).toMatchObject({ cpuPct: null, memPct: null, diskPct: null, connUsed: null, connMax: null, prev: null });
  });

  it("gives null shares for a zero total", () => {
    expect(computeValues({ cpu: null, memTotal: 0, memAvailable: 0, diskSize: 0, diskAvail: 0, backends: 1, maxConnections: 0 }, null, "x"))
      .toEqual({ cpuPct: null, memPct: null, diskPct: null, connUsed: 1, connMax: 0 });
  });
});

describe("mergeHour (hourly rollups)", () => {
  it("averages and peaks CPU and RAM, keeps the newest disk %, the peak connections", () => {
    let r: HourRow | null = null;
    r = mergeHour(r, { cpuPct: null, memPct: 40, diskPct: 10, connUsed: 5, connMax: 60 });
    r = mergeHour(r, { cpuPct: 20, memPct: 60, diskPct: 11, connUsed: 9, connMax: 60 });
    r = mergeHour(r, { cpuPct: 40, memPct: 50, diskPct: null, connUsed: 3, connMax: null });
    expect(r).toEqual({ samples: 3, cpuSamples: 2, cpuAvg: 30, cpuMax: 40, memAvg: 50, memMax: 60, diskPct: 11, connUsed: 9, connMax: 60 });
  });

  it("lays out 24 hourly points, oldest first, with gaps", () => {
    const now = new Date("2026-10-16T10:20:00Z");
    expect(hourStart(now).toISOString()).toBe("2026-10-16T10:00:00.000Z");
    const row = (h: string, cpuAvg: number) => ({ hour: new Date(h), samples: 1, cpuSamples: 1, cpuAvg, cpuMax: cpuAvg, memAvg: null, memMax: null, diskPct: null, connUsed: null, connMax: null });
    const s = hourSeries([row("2026-10-16T10:00:00Z", 7), row("2026-10-15T11:00:00Z", 3), row("2026-10-15T10:00:00Z", 99)], "cpuAvg", now);
    expect(s).toHaveLength(24);
    expect(s[0]).toBe(3);
    expect(s[23]).toBe(7);
    expect(s.slice(1, 23).every((v) => v === null)).toBe(true);
  });
});

describe("ComputeHigh limits and breaches", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const latest = (o: Partial<MetricsLatest> = {}): MetricsLatest => ({
    at: at(1), cpuPct: 10, memPct: 40, diskPct: 20, connUsed: 10, connMax: 60, prev: null, recent: [], ...o,
  });

  it("derives the four limits from the one threshold (RAM 10 points higher, capped at 99)", () => {
    expect(computeLimits(null)).toEqual({ cpu: 80, ram: 90, disk: 80, conn: 80 });
    expect(computeLimits(95)).toEqual({ cpu: 95, ram: 99, disk: 95, conn: 95 });
  });

  it("is ok under the limits and unknown without a fresh scrape", () => {
    const L = computeLimits(80);
    expect(computeBreaches(latest(), L, now)).toEqual([]);
    expect(computeBreaches(null, L, now)).toBeNull();
    expect(computeBreaches(latest({ at: at(25) }), L, now)).toBeNull();
  });

  it("fires CPU only when every scrape of the last 15 minutes is above the limit", () => {
    const L = computeLimits(80);
    const high = [at(15), at(10), at(5), at(0)].map((a, i) => ({ at: a, cpu: 85 + i }));
    expect(computeBreaches(latest({ recent: high }), L, now)).toEqual(["CPU 85%+ for 15 min (limit 80%)"]);
    expect(computeBreaches(latest({ recent: [...high.slice(0, 2), { at: at(5), cpu: 50 }, high[3]] }), L, now)).toEqual([]);
    // two scrapes are not 15 minutes
    expect(computeBreaches(latest({ recent: high.slice(2) }), L, now)).toEqual([]);
  });

  it("fires RAM over T + 10, disk over T and connections over T % of max", () => {
    const L = computeLimits(80);
    expect(computeBreaches(latest({ memPct: 91, diskPct: 81, connUsed: 49, connMax: 60 }), L, now))
      .toEqual(["RAM 91% (limit 90%)", "disk 81% (limit 80%)", "connections 49 of 60 (limit 80%)"]);
    expect(computeBreaches(latest({ memPct: 90, diskPct: 80, connUsed: 48, connMax: 60 }), L, now)).toEqual([]);
    expect(computeBreaches(latest({ connUsed: 59, connMax: null }), L, now)).toEqual([]);
  });
});

describe("scrapeDue (5-minute slot)", () => {
  const t = (min: number) => new Date(Date.UTC(2026, 9, 16, 10, min, 10));
  it("scrapes in a slot's first minute, then not again inside the slot", () => {
    expect(scrapeDue(t(0), null)).toBe(true);
    expect(scrapeDue(t(1), null)).toBe(false);
    expect(scrapeDue(t(1), t(0).getTime())).toBe(false);
    expect(scrapeDue(t(5), t(0).getTime())).toBe(true);
  });
  it("catches up when the instance's last scrape is two slots old", () => {
    expect(scrapeDue(t(13), t(2).getTime())).toBe(true);
  });
});

describe("computeLine (patrol)", () => {
  it("reads like the owner's example", () => {
    expect(computeLine({ cpuPct: 12.4, memPct: 41, diskPct: 8, connUsed: 9, connMax: 60 })).toBe("CPU 12 %, RAM 41 %, disk 8 %, connections 9/60");
    expect(computeLine({ cpuPct: null, memPct: 41, diskPct: null, connUsed: null, connMax: null })).toBe("RAM 41 %");
  });
});
