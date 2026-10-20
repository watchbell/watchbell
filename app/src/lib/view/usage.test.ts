import { describe, expect, it } from "vitest";
import type { MetricsLatest } from "@/lib/databases/compute-metrics";
import type { DbRow } from "@/lib/data/databases-db";
import { buildAliasBook } from "./display-name";
import { computePanel, usagePhrases, usageRows } from "./usage";

const now = new Date("2026-10-16T12:00:00Z");
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
const row = (o: Partial<DbRow> & { id: string; kind: DbRow["kind"]; data: unknown }): DbRow => ({
  name: o.id, externalId: o.id, account: "acc", state: "ok", stateSince: null, collectedAt: at(3), usedBy: [], ...o,
});
const latest = (o: Partial<MetricsLatest> = {}): MetricsLatest => ({ at: at(2).toISOString(), cpuPct: 12.4, memPct: 41, diskPct: 8, connUsed: 9, connMax: 60, prev: null, recent: [], ...o });

describe("computePanel", () => {
  it("has three shapes: no key, waiting for the first scrape (or its error), values", () => {
    expect(computePanel(undefined, now)).toEqual({ kind: "none" });
    expect(computePanel({ latest: null, lastTryAt: null, lastOkAt: null, lastError: null, hours: [] }, now)).toEqual({ kind: "waiting", note: "Waiting for the first scrape (every 5 minutes)." });
    expect(computePanel({ latest: null, lastTryAt: at(4), lastOkAt: null, lastError: "Supabase rejected the metrics key (401).", hours: [] }, now))
      .toEqual({ kind: "waiting", note: "Last try 4 min ago: Supabase rejected the metrics key (401)." });
  });

  it("shows CPU, RAM, disk and connections now with 24 hourly points, peaks and as-of", () => {
    const hours = [{ hour: new Date("2026-10-16T11:00:00Z"), samples: 12, cpuSamples: 12, cpuAvg: 20, cpuMax: 55, memAvg: 40, memMax: 44, diskPct: 8, connUsed: 30, connMax: 60 }];
    const p = computePanel({ latest: latest({ memPct: 92 }), lastTryAt: at(2), lastOkAt: at(2), lastError: null, hours }, now);
    if (p.kind !== "ok") throw new Error("expected values");
    expect(p.asOf).toBe("2 min ago");
    expect(p.stale).toBe(false);
    expect(p.gauges.map((g) => [g.label, g.value, g.tone])).toEqual([["CPU", "12%", undefined], ["RAM", "92%", "warn"], ["Disk", "8%", undefined], ["Connections", "9 / 60", undefined]]);
    expect(p.gauges[0].series).toHaveLength(24);
    expect(p.gauges[0].series[22]).toBe(20);
    expect(p.gauges[0].peak).toBe("55% peak 24 h");
    expect(p.gauges[3].series[22]).toBe(50);
  });

  it("marks values older than 20 minutes as not updating", () => {
    const p = computePanel({ latest: latest({ at: at(40).toISOString() }), lastTryAt: at(1), lastOkAt: at(40), lastError: "timeout", hours: [] }, now);
    expect(p).toMatchObject({ kind: "ok", stale: true, error: "timeout" });
  });
});

describe("usageRows (cross-provider overview)", () => {
  const supa = row({ id: "s1", kind: "supabase_project", data: { sizeBytes: 100 * 1024 ** 2, sizeAt: at(30).toISOString() } });
  const neon = row({ id: "n1", kind: "neon_project", data: { computeSeconds: 41 * 3600, transferBytes: 1024 ** 3, activeSeconds: 7200, branches: [{ id: "b", name: "main", isDefault: true, logicalSize: 50 * 1024 ** 2 }] } });
  const fs = row({ id: "f1", kind: "firestore", data: { reads: 25_000, writes: 100, deletes: 0, opsAt: at(5).toISOString() } });
  const fsBlocked = row({ id: "f2", kind: "firestore", data: { reads: null, opsAt: at(5).toISOString(), opsError: "Not available on Spark: Firestore usage needs billing (Blaze plan)" } });

  it("picks each database's highest share and says where it comes from", () => {
    const rows = usageRows({ supabase: [supa], neon: [neon], firestore: [fs, fsBlocked], compute: new Map() }, now);
    expect(rows.map((r) => [r.provider, r.main?.label ?? null, r.main ? Math.round(r.main.pct ?? 0) : null, r.source, r.asOf])).toEqual([
      ["Supabase", "Database size", 20, "api", "30 min ago"],
      ["Neon", "Compute", 41, "api", "3 min ago"],
      ["Firestore", "Reads today", 50, "monitoring", "5 min ago"],
      ["Firestore", null, null, "monitoring", "5 min ago"],
    ]);
    expect(rows[0].note).toContain("No metrics key");
    expect(rows[0].note).toContain("Egress and MAU: not readable");
    expect(rows[1].extra).toEqual(["Storage 5%", "Transfer 20%", "active 2 h this month"]);
    expect(rows[2].note).toContain("Storage (1 GiB): not readable");
    expect(rows[3].note).toBe("Not available on Spark: Firestore usage needs billing (Blaze plan)");
  });

  it("uses fresh Metrics API values for Supabase when they are the highest share", () => {
    const rows = usageRows({ supabase: [supa], neon: [], firestore: [], compute: new Map([["s1", { latest: latest({ memPct: 70 }) }]]) }, now);
    expect(rows[0]).toMatchObject({ source: "metrics", main: { label: "RAM", pct: 70 }, asOf: "2 min ago" });
    expect(rows[0].extra).toContain("DB 20% of 500 MB");
    const stale = usageRows({ supabase: [supa], neon: [], firestore: [], compute: new Map([["s1", { latest: latest({ at: at(60).toISOString(), memPct: 70 }) }]]) }, now);
    expect(stale[0]).toMatchObject({ source: "api", main: { label: "Database size" } });
  });

  it("ignores Firestore counts from before today's Pacific reset", () => {
    const old = row({ id: "f3", kind: "firestore", data: { reads: 40_000, opsAt: "2026-10-15T01:00:00Z" } });
    expect(usageRows({ supabase: [], neon: [], firestore: [old], compute: new Map() }, now)[0].main).toBeNull();
  });
});

describe("usagePhrases (patrol)", () => {
  it("gives the compute line for Supabase with a key, the main share otherwise, by alias", () => {
    const supa = row({ id: "s1", kind: "supabase_project", data: {} });
    const neon = row({ id: "n1", kind: "neon_project", data: { computeSeconds: 12 * 3600 } });
    const compute = new Map([["s1", { latest: latest() }]]);
    const book = buildAliasBook([
      { id: "s1", kind: "supabase_project", name: "quillpad", firstSeenAt: "2026-01-01T00:00:00Z" },
      { id: "n1", kind: "neon_project", name: "ticketer", firstSeenAt: "2026-01-02T00:00:00Z" },
    ], []);
    const rows = usageRows({ supabase: [supa], neon: [neon], firestore: [], compute }, now, book);
    const m = usagePhrases(rows, compute, now);
    expect(Object.fromEntries(m)).toEqual({ "db-a": "CPU 12 %, RAM 41 %, disk 8 %, connections 9/60", "db-b": "Compute 12 % of 100 CU-h" });
    expect(JSON.stringify(Object.fromEntries(m))).not.toMatch(/quillpad|ticketer/);
  });
});
