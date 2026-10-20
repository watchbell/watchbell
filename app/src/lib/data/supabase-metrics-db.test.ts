import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseMetrics, supabaseMetricsKeys } from "@/db/compute-schema";
import { open, seal } from "@/lib/crypto";
import type { MetricsLatest } from "@/lib/databases/compute-metrics";
import { fakeDb, limitOf, payloadOf } from "./fake-db";

const ENC = Buffer.alloc(32, 7).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }) }));

import { computeFacts, readCompute, removeMetricsKey, resetScrapeThrottle, saveMetricsKey, scrapeSupabaseMetrics } from "./supabase-metrics-db";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const ID2 = "223e4567-e89b-42d3-a456-426614174000";
const ID3 = "323e4567-e89b-42d3-a456-426614174000";
const REF = "abcdefghijklmnopqrst";
const KEY = "sb_secret" + "_FAKE_test_key_not_real_0000";
const USER = "423e4567-e89b-42d3-a456-426614174000";
const BODY = `node_cpu_seconds_total{cpu="0",mode="idle"} 400
node_cpu_seconds_total{cpu="0",mode="user"} 100
node_memory_MemTotal_bytes 1000
node_memory_MemAvailable_bytes 250
node_filesystem_size_bytes{fstype="ext4",mountpoint="/data"} 100
node_filesystem_avail_bytes{fstype="ext4",mountpoint="/data"} 90
pg_stat_database_num_backends{datname="postgres"} 12
pg_settings_max_connections 60
`;
// A minute that starts a 5-minute slot, so the throttle lets the scrape run.
const SLOT = new Date("2026-10-16T10:05:10Z");

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  resetScrapeThrottle();
});

const ok = () => vi.fn(async () => ({ ok: true as const, data: BODY }));

describe("saveMetricsKey", () => {
  it("refuses malformed input before any read or call", async () => {
    db = fakeDb([]);
    h.current = db;
    const f = ok();
    for (const [id, ref, key] of [["x", REF, KEY], [ID, "bad ref", KEY], [ID, REF, "sb_publishable_xxxxxxxxxx"]]) {
      expect(await saveMetricsKey(id, ref, key, USER, SLOT, { fetchMetrics: f })).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    }
    expect(db.queries).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a project that isn't watched, or whose ref changed since the dialog opened", async () => {
    const f = ok();
    h.current = fakeDb([[]]);
    expect(await saveMetricsKey(ID, REF, KEY, USER, SLOT, { fetchMetrics: f })).toEqual({ ok: false, error: "That Supabase project is no longer watched." });
    h.current = fakeDb([[{ id: ID, name: "quillpad", ref: "zyxwvutsrqponmlkjihg" }]]);
    expect(await saveMetricsKey(ID, REF, KEY, USER, SLOT, { fetchMetrics: f })).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(f).not.toHaveBeenCalled();
  });

  it("doesn't store a key Supabase rejects", async () => {
    db = fakeDb([[{ id: ID, name: "quillpad", ref: REF }]]);
    h.current = db;
    const f = vi.fn(async () => ({ ok: false as const, kind: "auth" as const, status: 401, error: "Supabase rejected the metrics key (401). Replace it with a current Secret API key." }));
    expect(await saveMetricsKey(ID, REF, KEY, USER, SLOT, { fetchMetrics: f })).toMatchObject({ ok: false, error: expect.stringContaining("rejected") });
    expect(db.writes).toHaveLength(0);
  });

  it("stores the key sealed (never in clear), with the test call as the first scrape", async () => {
    db = fakeDb([[{ id: ID, name: "quillpad", ref: REF }]]);
    h.current = db;
    const f = ok();
    const r = await saveMetricsKey(ID, REF, KEY, USER, SLOT, { fetchMetrics: f });
    expect(r).toEqual({ ok: true, message: expect.stringContaining("Metrics key saved for quillpad"), audit: { message: "Metrics key saved · quillpad", resourceId: ID } });
    expect(f).toHaveBeenCalledWith(REF, KEY, { timeoutMs: 8000 });
    const w = db.writes[0];
    expect(w.table).toBe(supabaseMetricsKeys);
    const v = payloadOf(w.calls)!;
    expect(JSON.stringify(v)).not.toContain(KEY);
    expect(open({ ciphertext: v.keyCiphertext as string, iv: v.keyIv as string }, ENC)).toBe(KEY);
    expect(v).toMatchObject({ resourceId: ID, addedBy: USER, lastError: null, lastOkAt: SLOT, latest: expect.objectContaining({ memPct: 75, diskPct: 10, connUsed: 12, connMax: 60, cpuPct: null }) });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("stores the key when the test call only timed out, and says so", async () => {
    db = fakeDb([[{ id: ID, name: "quillpad", ref: REF }]]);
    h.current = db;
    const f = vi.fn(async () => ({ ok: false as const, kind: "transient" as const, error: "Supabase Metrics API didn't answer within 8 seconds." }));
    expect(await saveMetricsKey(ID, REF, KEY, USER, SLOT, { fetchMetrics: f })).toMatchObject({ ok: true, message: expect.stringContaining("test call failed") });
    expect(payloadOf(db.writes[0].calls)).toMatchObject({ latest: null, lastOkAt: null, lastError: "Supabase Metrics API didn't answer within 8 seconds." });
  });
});

describe("removeMetricsKey", () => {
  it("deletes the key and the project's rollups", async () => {
    db = fakeDb([[{ name: "quillpad" }]], [[{ id: ID }], []]);
    h.current = db;
    expect(await removeMetricsKey(ID)).toEqual({ ok: true, message: "Metrics key removed for quillpad. Revoke it in Supabase too.", audit: { message: "Metrics key removed · quillpad", resourceId: ID } });
    expect(db.writes.map((w) => [w.kind, w.table])).toEqual([["delete", supabaseMetricsKeys], ["delete", supabaseMetrics]]);
  });
  it("says so when there is no key", async () => {
    h.current = fakeDb([[{ name: "quillpad" }]], [[]]);
    expect(await removeMetricsKey(ID)).toEqual({ ok: false, error: "This project has no metrics key." });
    expect(await removeMetricsKey("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
  });
});

describe("scrapeSupabaseMetrics", () => {
  const sealed = seal(KEY, ENC);
  const keyRow = (id: string, latest: MetricsLatest | null = null) => ({ resourceId: id, keyCiphertext: sealed.ciphertext, keyIv: sealed.iv, keyVersion: 1, latest });
  const deps = (f: ReturnType<typeof vi.fn>) => ({ fetchMetrics: f as never, key: () => ENC });

  it("runs once per 5-minute slot", async () => {
    db = fakeDb([[]]);
    h.current = db;
    expect(await scrapeSupabaseMetrics(new Date("2026-10-16T10:06:10Z"), Date.now() + 30_000, deps(ok()))).toBeNull();
    expect(await scrapeSupabaseMetrics(SLOT, Date.now() + 30_000, deps(ok()))).toEqual({ scraped: 0, failed: 0 });
    expect(await scrapeSupabaseMetrics(new Date(SLOT.getTime() + 60_000), Date.now() + 30_000, deps(ok()))).toBeNull();
    expect(db.queries).toHaveLength(1);
    expect(limitOf(db.queries[0])).toBe(20);
  });

  it("scrapes each keyed project, records each failure on its own row, skips paused ones, then prunes old rollups", async () => {
    const prev: MetricsLatest = { at: new Date(SLOT.getTime() - 300_000).toISOString(), cpuPct: null, memPct: 1, diskPct: 1, connUsed: 1, connMax: 60, prev: { at: new Date(SLOT.getTime() - 300_000).toISOString(), busy: 50, total: 250 }, recent: [] };
    db = fakeDb([
      [{ k: keyRow(ID, prev), ref: REF, state: "ok" }, { k: keyRow(ID2), ref: "bbbbbbbbbbbbbbbbbbbb", state: "ok" }, { k: keyRow(ID3), ref: "cccccccccccccccccccc", state: "paused" }],
      [], // the hour row of ID: none yet
    ]);
    h.current = db;
    const f = vi.fn<(ref: string, key: string, o: { timeoutMs: number }) => Promise<unknown>>(async (ref) => (ref === REF ? { ok: true as const, data: BODY } : { ok: false as const, kind: "auth" as const, error: "Supabase rejected the metrics key (401). Replace it with a current Secret API key." }));
    expect(await scrapeSupabaseMetrics(SLOT, Date.now() + 30_000, deps(f))).toEqual({ scraped: 1, failed: 2 });
    expect(f).toHaveBeenCalledTimes(2); // not the paused one
    expect(f.mock.calls[0]).toEqual([REF, KEY, { timeoutMs: expect.any(Number) }]);
    expect(f.mock.calls[0][2]!.timeoutMs).toBeLessThanOrEqual(8000);
    const [latestW, hourW, fail2, fail3, prune] = db.writes;
    // busy 100 − 50 of total 500 − 250 → 20 %
    expect(payloadOf(latestW.calls)).toMatchObject({ lastError: null, latest: expect.objectContaining({ cpuPct: 20, memPct: 75, diskPct: 10, connUsed: 12, recent: [{ at: SLOT.toISOString(), cpu: 20 }] }) });
    expect(hourW.table).toBe(supabaseMetrics);
    expect(payloadOf(hourW.calls)).toMatchObject({ resourceId: ID, hour: new Date("2026-10-16T10:00:00Z"), samples: 1, cpuSamples: 1, cpuAvg: 20, memAvg: 75, connUsed: 12 });
    expect(payloadOf(fail2.calls)).toEqual({ lastTryAt: SLOT, lastError: expect.stringContaining("rejected") });
    expect(payloadOf(fail3.calls)).toEqual({ lastTryAt: SLOT, lastError: "The project is paused." });
    expect([prune.kind, prune.table]).toEqual(["delete", supabaseMetrics]);
    expect(JSON.stringify(db.writes.map((w) => payloadOf(w.calls) ?? null))).not.toContain(KEY);
  });

  it("stops at the deadline and never throws when the database fails", async () => {
    h.current = fakeDb([[{ k: keyRow(ID), ref: REF, state: "ok" }]]);
    const f = ok();
    expect(await scrapeSupabaseMetrics(SLOT, Date.now() + 200, deps(f))).toEqual({ scraped: 0, failed: 0 });
    expect(f).not.toHaveBeenCalled();
    resetScrapeThrottle();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.current = fakeDb([new Error("db down")]);
    await expect(scrapeSupabaseMetrics(SLOT, Date.now() + 30_000, deps(f))).resolves.toEqual({ scraped: 0, failed: 0 });
    expect(warn).toHaveBeenCalledWith("supabase-metrics failed:", "Error");
    warn.mockRestore();
  });

  it("a key that can't be opened is one project's error", async () => {
    db = fakeDb([[{ k: { ...keyRow(ID), keyCiphertext: "AAAA" }, ref: REF, state: "ok" }]]);
    h.current = db;
    const f = ok();
    expect(await scrapeSupabaseMetrics(SLOT, Date.now() + 30_000, deps(f))).toEqual({ scraped: 0, failed: 1 });
    expect(f).not.toHaveBeenCalled();
    expect(payloadOf(db.writes[0].calls)).toMatchObject({ lastError: "The stored key can't be read. Add it again." });
  });
});

describe("reads", () => {
  it("readCompute selects no secret column and groups the hourly rows", async () => {
    const hour = { resourceId: ID, hour: new Date("2026-10-16T10:00:00Z"), samples: 1, cpuSamples: 0, cpuAvg: null, cpuMax: null, memAvg: 50, memMax: 50, diskPct: 10, connUsed: 3, connMax: 60 };
    db = fakeDb([[{ resourceId: ID, latest: null, lastTryAt: null, lastOkAt: null, lastError: "x" }], [hour]]);
    h.current = db;
    const m = await readCompute([ID, "nope"], SLOT);
    expect(m.get(ID)).toEqual({ latest: null, lastTryAt: null, lastOkAt: null, lastError: "x", hours: [hour] });
    const fields = Object.keys(db.queries[0][0].args[0] as object);
    expect(fields).not.toContain("keyCiphertext");
    expect(fields).not.toContain("keyIv");
    expect(limitOf(db.queries[1])).toBe(24);
    h.current = fakeDb([]);
    expect((await readCompute([], SLOT)).size).toBe(0);
  });

  it("computeFacts is null without keys", async () => {
    h.current = fakeDb([[]]);
    expect(await computeFacts()).toBeNull();
    h.current = fakeDb([[{ id: ID, name: "quillpad", latest: null }]]);
    expect(await computeFacts()).toEqual([{ id: ID, name: "quillpad", latest: null }]);
  });
});
