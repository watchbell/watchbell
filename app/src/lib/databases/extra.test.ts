import { describe, expect, it } from "vitest";
import { dbFact } from "@/lib/alerts/facts-map";
import { evaluate } from "@/lib/alerts/evaluate";
import type { Facts } from "@/lib/alerts/facts";
import type { DbRow } from "@/lib/data/databases-db";
import { databaseEvent } from "./events";
import { D1_FREE, d1Shares, d1State, topQuota, TURSO_FREE, tursoShares, tursoState, UPSTASH_FREE, upstashShares, upstashState } from "./extra";
import { usageRows } from "@/lib/view/usage";
import { d1AccessNote, d1Views, parseD1Access, tursoViews, upstashViews } from "@/lib/view/extra-dbs";

const now = new Date("2026-10-16T05:00:00Z");
const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe("stage 8 free-plan constants (checked 16 Oct 2026)", () => {
  it("match the official pages", () => {
    expect(TURSO_FREE).toEqual({ databases: 100, storageBytes: 5 * GB, rowsRead: 500_000_000, rowsWritten: 10_000_000 });
    expect(UPSTASH_FREE).toEqual({ storageBytes: 250 * MB, monthlyCommands: 500_000, monthlyBandwidthBytes: 10 * GB });
    expect(D1_FREE).toEqual({ databases: 10, dbBytes: 500 * MB, accountBytes: 5 * GB, rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000 });
  });
});

describe("usage shares", () => {
  it("Turso: the organization's month against the org-wide limits, only for this calendar month", () => {
    const d = { orgRowsRead: 125_000_000, orgRowsWritten: 9_000_000, orgStorageBytes: GB, usageAt: "2026-10-16T04:16:00Z" };
    expect(tursoShares(d, now).map((s) => [s.label, s.pct])).toEqual([["Rows read", 25], ["Rows written", 90], ["Storage", 20]]);
    expect(topQuota(tursoShares(d, now))?.label).toBe("Rows written");
    expect(tursoShares({ ...d, usageAt: "2026-09-30T23:16:00Z" }, now)).toEqual([]);
  });
  it("Upstash: commands and bandwidth this month, data size any time", () => {
    const d = { monthlyRequests: 410_000, monthlyBandwidthBytes: GB, storageBytes: 125 * MB, statsAt: "2026-10-16T04:16:00Z" };
    expect(upstashShares(d, now).map((s) => [s.label, s.pct, s.kind])).toEqual([["Commands", 82, "quota"], ["Bandwidth", 10, "quota"], ["Data size", 50, "storage"]]);
    expect(upstashShares({ ...d, statsAt: "2026-09-30T23:00:00Z" }, now).map((s) => s.label)).toEqual(["Data size"]);
  });
  it("D1: the account's rows today (UTC) and the database's size", () => {
    const d = { accountRowsRead: 4_000_000, accountRowsWritten: 1_000, sizeBytes: 50 * MB, usageDay: "2026-10-16" };
    expect(d1Shares(d, now).map((s) => [s.label, s.pct])).toEqual([["Rows read today", 80], ["Rows written today", 1], ["Size", 10]]);
    expect(d1Shares({ ...d, usageDay: "2026-10-15" }, now).map((s) => s.label)).toEqual(["Size"]);
  });
  it("topQuota ignores storage and unread shares", () => {
    expect(topQuota([{ label: "Size", pct: 99, text: "", kind: "storage" }])).toBeNull();
  });
});

describe("states", () => {
  it("Turso: a block on the database or the organization is red", () => {
    expect(tursoState({ blockReads: false, blockWrites: false })).toEqual({ state: "ok", label: "Available" });
    expect(tursoState({ blockReads: false, blockWrites: true })).toEqual({ state: "err", label: "Writes blocked" });
    expect(tursoState({ blockReads: false, blockWrites: false, orgBlockedReads: true })).toEqual({ state: "err", label: "Reads blocked" });
  });
  it("Upstash: active is ok, suspended is red, anything new is unknown", () => {
    expect(upstashState("active").state).toBe("ok");
    expect(upstashState("suspended").state).toBe("err");
    expect(upstashState("migrating")).toEqual({ state: "unknown", label: "State: migrating" });
  });
  it("D1: red only when the account used a daily row quota", () => {
    expect(d1State({ accountRowsRead: 4_999_999, accountRowsWritten: 0 }).state).toBe("ok");
    expect(d1State({ accountRowsRead: 5_000_000, accountRowsWritten: 0 }).label).toBe("Daily rows-read limit reached");
    expect(d1State({ accountRowsRead: null, accountRowsWritten: 100_000 }).state).toBe("err");
  });
  it("raises an event on a block and on its end, never on first sight", () => {
    const base = { resourceId: "r", label: "Writes blocked", at: now };
    expect(databaseEvent({ ...base, kind: "turso_database", prev: "ok", next: "err" })).toMatchObject({ reason: "DatabaseFailed", message: "Turso database: writes blocked" });
    expect(databaseEvent({ ...base, kind: "d1_database", prev: "err", next: "ok", label: "Available" })).toMatchObject({ reason: "DatabaseRestored" });
    expect(databaseEvent({ ...base, kind: "upstash_redis", prev: null, next: "err" })).toBeNull();
  });
});

const row = (kind: DbRow["kind"], data: Record<string, unknown>, id = `${kind}-1`): DbRow => ({
  id, name: `${kind} name`, externalId: "ext", kind, account: "acc", state: "ok", stateSince: now, collectedAt: now, data, usedBy: [],
});

describe("alert facts and DbQuotaHigh", () => {
  const facts = (dbs: Facts["dbs"]): Facts => ({ now, lastMinuteRunAt: now, monitors: [], apps: [], accounts: [], dbs, domains: null, dns: null, links: [] });
  const rule = { key: "DbQuotaHigh" as const, severity: "warning" as const, threshold: 80, enabled: true, channels: [] };

  it("fires past the threshold with the quota named, holds when nothing was read, and leaves the old providers alone", () => {
    const turso = dbFact({ id: "t", name: "notes", kind: "turso_database", state: "ok", data: { orgRowsRead: 450_000_000, orgRowsWritten: 0, orgStorageBytes: GB, usageAt: "2026-10-16T04:16:00Z" } }, now)!;
    const upstash = dbFact({ id: "u", name: "cache", kind: "upstash_redis", state: "ok", data: { monthlyRequests: 100_000, statsAt: "2026-10-16T04:16:00Z" } }, now)!;
    const d1 = dbFact({ id: "d", name: "blog", kind: "d1_database", state: "ok", data: {} }, now)!;
    const neon = dbFact({ id: "n", name: "pg", kind: "neon_project", state: "ok", data: {} }, now)!;
    expect(turso).toMatchObject({ provider: "turso", quotaPct: 90, sizeBytes: GB, sizeLimitBytes: 5 * GB });
    const { observations } = evaluate(facts([turso, upstash, d1, neon]), [rule]);
    expect(observations.map((o) => [o.subject, o.status, o.provider])).toEqual([["t", "firing", "turso"], ["u", "ok", "upstash"], ["d", "unknown", "cloudflare"]]);
    expect(observations[0].message).toBe("notes: Rows read of 500M this month (org) at 90% of the free plan.");
  });

  it("StorageAlmostFull covers their storage too", () => {
    const up = dbFact({ id: "u", name: "cache", kind: "upstash_redis", state: "ok", data: { storageBytes: 240 * MB } }, now)!;
    const r = evaluate(facts([up]), [{ key: "StorageAlmostFull", severity: "warning", threshold: 80, enabled: true, channels: [] }]);
    expect(r.observations[0]).toMatchObject({ status: "firing", provider: "upstash" });
  });
});

describe("Free databases overview and the pages", () => {
  it("adds a row per Turso, Upstash and D1 database with its source", () => {
    const rows = usageRows({
      supabase: [], neon: [], firestore: [], compute: new Map(),
      turso: [row("turso_database", { orgRowsRead: 50_000_000, orgRowsWritten: 100_000, orgStorageBytes: GB / 2, usageAt: "2026-10-16T04:16:00Z" })],
      upstash: [row("upstash_redis", { monthlyRequests: 250_000, storageBytes: 25 * MB, statsAt: "2026-10-16T04:16:00Z" })],
      d1: [row("d1_database", { sizeBytes: 5 * MB, accountRowsRead: 500_000, accountRowsWritten: 50_000, usageDay: "2026-10-16", usageAt: "2026-10-16T04:16:00Z" })],
    }, now);
    expect(rows.map((r) => [r.provider, r.href, r.source, r.main?.label, r.main?.pct])).toEqual([
      ["Turso", "/turso", "api", "Rows read", 10],
      ["Upstash", "/upstash", "api", "Commands", 50],
      ["D1", "/d1", "graphql", "Rows written today", 50],
    ]);
    expect(rows[2].extra).toEqual(["Rows read today 10%", "Size 1%"]);
  });

  it("builds the page rows, with D1's table count marked approximate", () => {
    const t = tursoViews([row("turso_database", { group: "default", primaryRegion: "aws-ap-northeast-1", orgRowsRead: 1_500_000, usageAt: "2026-10-16T04:16:00Z" })], now)[0];
    expect(t.sub).toBe("group default · aws-ap-northeast-1");
    expect(t.meters[0]).toEqual({ label: "Rows read", value: "1.5M", of: "of 500M this month (org)", pct: 0.3 });
    const u = upstashViews([row("upstash_redis", { region: "ap-southeast-1", storageBytes: 25 * MB })], now)[0];
    expect(u.meters.map((m) => m.value)).toEqual(["—", "25 MB", "—"]);
    const d = d1Views([row("d1_database", { sizeBytes: 5 * MB, numTables: 4 })], now)[0];
    expect([d.size, d.tables, d.status.label]).toEqual(["5 MB", "~4", "Available"]);
  });

  it("explains the D1 permission to add, per Cloudflare account", () => {
    const access = parseD1Access({ a: { d1: "missing", analytics: null, at: "x", note: null }, b: { d1: "ok", analytics: "missing", at: "x", note: null }, c: { d1: "ok", analytics: "ok", at: "x", note: null }, bad: { d1: 3 } });
    expect(Object.keys(access)).toEqual([]); // one bad entry: the whole value is ignored, never half-read
    const ok = parseD1Access({ a: { d1: "missing", analytics: null, at: "x", note: null }, b: { d1: "ok", analytics: "missing", at: "x", note: null }, c: { d1: "ok", analytics: "ok", at: "x", note: null } });
    expect(d1AccessNote(ok.a)?.text).toContain("Account → D1 → Read");
    expect(d1AccessNote(ok.b)).toMatchObject({ tone: "info" });
    expect(d1AccessNote(ok.b)?.text).toContain("Account → Account Analytics → Read");
    expect(d1AccessNote(ok.c)).toBeNull();
    expect(d1AccessNote(undefined)?.text).toContain("hourly");
  });
});
