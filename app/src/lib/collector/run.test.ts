import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checks, events, monitors } from "@/db/schema";
import { type Call, fakeDb, payloadOf, whereOf } from "@/lib/data/fake-db";
import type { CheckResult } from "./http-check";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  checkUrl: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/data/sections-db", async (orig) => ({ ...(await orig<typeof import("@/lib/data/sections-db")>()), pausedSections: async () => new Set() }));
vi.mock("next/cache", () => ({ revalidateTag: h.revalidateTag, updateTag: vi.fn() }));
vi.mock("./http-check", async (orig) => ({ ...(await orig<typeof import("./http-check")>()), checkUrl: h.checkUrl }));

import { checkMonitorNow } from "@/lib/data/monitors-db";
import { taskHeartbeats } from "@/lib/data/heartbeats-db";
import { heartbeatMaintenance, runMainTasks, runPostTasks, settleRun, taskChecks, windowsForRun } from "./run";
import { ALERTS_RESERVE_MS, BUDGET_MS, dueTasks, POST_TASKS } from "./schedule";

type Row = {
  id: string; resourceId: string; url: string; expectedStatus: number; timeoutMs: number; intervalS: number; paused: boolean; ownerPaused: boolean;
  state: string; stateSince: Date; failStreak: number; lastCheckedAt: Date | null; lastStatus: number | null; lastLatencyMs: number | null;
  bodyContains?: string | null; jsonPath?: string | null; jsonEquals?: string | null; lastError?: string | null;
};
const app = { id: "a1", name: "web" };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, resourceId: "a1", url: `https://web.example.com/${id}`, expectedStatus: 200, timeoutMs: 10_000, intervalS: 60, paused: false, ownerPaused: false,
  state: "ok", stateSince: new Date("2026-10-12T00:00:00Z"), failStreak: 0, lastCheckedAt: new Date("2026-01-01T00:00:00Z"),
  lastStatus: 200, lastLatencyMs: 100, ...over,
});

// A tiny stand-in for the monitors table: an UPDATE only applies (and returns the row) while its WHERE still matches the
// stored row, which is what the compare-and-set relies on. The WHERE is rendered to SQL and its parameters compared.
function table(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const update = (calls: Call[]) => {
    const where = whereOf(calls);
    if (!where) return []; // an insert (checks, events) that took this answer from the queue
    const q = new PgDialect().sqlToQuery(where.getSQL() as never);
    const target = [...byId.values()].find((r) => q.params.includes(r.id));
    if (!target) return [];
    const nullCheck = /"last_checked_at" is null/.test(q.sql);
    const same = (nullCheck ? target.lastCheckedAt === null : target.lastCheckedAt !== null && q.params.includes(target.lastCheckedAt.toISOString()))
      && [target.state, target.failStreak, target.url, target.expectedStatus].every((v) => q.params.includes(v));
    if (!same) return [];
    Object.assign(target, payloadOf(calls));
    return [{ id: target.id }];
  };
  return { byId, update };
}

beforeEach(() => {
  h.current = null;
  h.checkUrl.mockReset();
  h.revalidateTag.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const fail: CheckResult = { ok: false, statusCode: 502, latencyMs: 90, error: "HTTP 502" };
const insertsInto = (f: ReturnType<typeof fakeDb>, t: unknown) => f.writes.filter((w) => w.kind === "insert" && w.table === t);

describe("taskChecks: compare-and-set against Check now (final review I1)", () => {
  it("a Check now written between the run's read and its write survives the run, and the transition event is written once", async () => {
    const t = table([row("m1")]);
    const copy = () => ({ ...t.byId.get("m1")! });
    // Reads: the run's monitor list, then Check now's loadMonitor (its maintenance-window read then answers empty). Writes: Check now's update, its checks row and its
    // event, then the run's update (which must find the row changed), and nothing after it.
    const f = fakeDb(
      [() => [{ m: copy(), app }], () => [{ m: copy(), watched: true, goneAt: null }]],
      [t.update, [], [], t.update],
    );
    h.current = f;
    let checkNowResult: unknown;
    h.checkUrl.mockImplementationOnce(async () => {
      // The run's HTTP check is in flight: an operator presses Check now, which fetches and writes first.
      checkNowResult = await checkMonitorNow("m1");
      return fail;
    }).mockImplementationOnce(async () => fail);

    const runAt = new Date("2026-10-12T09:01:00Z");
    const n = await taskChecks(runAt, Date.now() + 20_000, [], false);

    expect(checkNowResult).toMatchObject({ ok: true, message: "Failed: HTTP 502.", passed: false });
    expect(n).toBe(0);
    const stored = t.byId.get("m1")!;
    expect(stored).toMatchObject({ state: "warn", failStreak: 1 }); // Check now's write, not overwritten by the run
    expect(stored.lastCheckedAt).not.toEqual(runAt);
    expect(insertsInto(f, events)).toHaveLength(1); // "Monitor degraded" once, from Check now
    expect(insertsInto(f, checks)).toHaveLength(1);
    expect(f.writes.filter((w) => w.kind === "update" && w.table === monitors)).toHaveLength(2);
  });

  it("writes its result, the checks row and the event when nothing changed the monitor meanwhile", async () => {
    const t = table([row("m1")]);
    const f = fakeDb([() => [{ m: { ...t.byId.get("m1")! }, app }]], [t.update]);
    h.current = f;
    h.checkUrl.mockResolvedValue(fail);
    expect(await taskChecks(new Date("2026-10-12T09:01:00Z"), Date.now() + 20_000, [], false)).toBe(1);
    expect(t.byId.get("m1")).toMatchObject({ state: "warn", failStreak: 1 });
    expect(insertsInto(f, checks)).toHaveLength(1);
    expect(insertsInto(f, events)).toHaveLength(1);
  });

  it("drops a result for a monitor that was resumed (state reset) or edited during the run", async () => {
    const t = table([row("m1", { state: "err", failStreak: 3 }), row("m2")]);
    const read = [{ m: { ...t.byId.get("m1")! }, app }, { m: { ...t.byId.get("m2")! }, app }];
    Object.assign(t.byId.get("m1")!, { state: "unknown", failStreak: 0 }); // Resume
    t.byId.get("m2")!.url = "https://web.example.com/new"; // Edit
    const f = fakeDb([read], [t.update, t.update]);
    h.current = f;
    h.checkUrl.mockResolvedValue(fail);
    expect(await taskChecks(new Date("2026-10-12T09:01:00Z"), Date.now() + 20_000, [], false)).toBe(0);
    expect(t.byId.get("m1")).toMatchObject({ state: "unknown", failStreak: 0 });
    expect(f.writes.filter((w) => w.kind === "insert")).toHaveLength(0);
  });
});

describe("taskChecks: maintenance windows (U5 / B3)", () => {
  const at = new Date("2026-10-12T18:30:00Z");
  const win = (o: Record<string, unknown> = {}) => ({ id: "w", scope: "app" as const, appId: "a1", monitorId: null, startsAt: new Date("2026-10-12T18:00:00Z"), durationMin: 60, weekly: false, note: null, ...o });
  it("keeps checking inside a window: the state still moves, and the checks row is marked in_maintenance", async () => {
    const t = table([row("m1"), row("m2", { resourceId: "a2" })]);
    const other = { id: "a2", name: "api" };
    const f = fakeDb([[{ m: { ...t.byId.get("m1")! }, app }, { m: { ...t.byId.get("m2")! }, app: other }]], [t.update, t.update]);
    h.current = f;
    h.checkUrl.mockResolvedValue(fail);
    expect(await taskChecks(at, Date.now() + 20_000, [], false, [win()])).toBe(2);
    expect(t.byId.get("m1")).toMatchObject({ state: "warn", failStreak: 1 });
    const [ins] = insertsInto(f, checks);
    expect((payloadOf(ins.calls) as unknown as { monitorId: string; inMaintenance: boolean }[]).map((r) => [r.monitorId, r.inMaintenance])).toEqual([["m1", true], ["m2", false]]);
  });
  it("marks nothing outside the window, or without windows", async () => {
    const t = table([row("m1")]);
    const f = fakeDb([[{ m: { ...t.byId.get("m1")! }, app }]], [t.update]);
    h.current = f;
    h.checkUrl.mockResolvedValue(fail);
    await taskChecks(new Date("2026-10-12T19:00:00Z"), Date.now() + 20_000, [], false, [win()]);
    expect((payloadOf(insertsInto(f, checks)[0].calls) as unknown as { inMaintenance: boolean }[])[0].inMaintenance).toBe(false);
  });
});

describe("windowsForRun: the collector's one read of the maintenance windows (U5, review M3)", () => {
  const w = { id: "w", scope: "all" as const, appId: null, monitorId: null, startsAt: new Date(), durationMin: 30, weekly: false, note: null };
  it("reads them once when checks are due, and not at all otherwise", async () => {
    const read = vi.fn().mockResolvedValue([w]);
    expect(await windowsForRun(["checks", "vercel"], [], read)).toEqual([w]);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    expect(await windowsForRun(["vercel", "status"], [], read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it("a failed read leaves the checks running as if there were no windows, and reports one line", async () => {
    const errors: string[] = [];
    expect(await windowsForRun(["checks"], errors, vi.fn().mockRejectedValue(new Error("connection reset")))).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^maintenance: /);
    const t = table([row("m1")]);
    const f = fakeDb([[{ m: { ...t.byId.get("m1")! }, app }]], [t.update]);
    h.current = f;
    h.checkUrl.mockResolvedValue(fail);
    expect(await taskChecks(new Date(), Date.now() + 20_000, errors, false, [])).toBe(1);
    expect((payloadOf(insertsInto(f, checks)[0].calls) as unknown as { inMaintenance: boolean }[])[0].inMaintenance).toBe(false);
    expect(errors).toHaveLength(1);
  });
  it("reads them once when heartbeats are due too, since heartbeat checks rows are marked the same way (B3)", async () => {
    const read = vi.fn().mockResolvedValue([w]);
    expect(await windowsForRun(["heartbeats"], [], read)).toEqual([w]);
    expect(await windowsForRun(["checks", "heartbeats", "vercel"], [], read)).toEqual([w]);
    expect(read).toHaveBeenCalledTimes(2); // one read per run
  });
  it("a failed read with only heartbeats due gives no windows and one line too", async () => {
    const errors: string[] = [];
    expect(await windowsForRun(["heartbeats"], errors, vi.fn().mockRejectedValue(new Error("connection reset")))).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/^maintenance: /)]);
  });
  it("reads ops.maintenance_windows by default (one query, at most 20 rows)", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    expect(await windowsForRun(["checks"], [])).toEqual([]);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0].find((c) => c.method === "limit")?.args[0]).toBe(20);
  });
});

describe("heartbeatMaintenance: the windows as taskHeartbeats' predicate (U3 + U5, B3)", () => {
  const at = new Date("2026-10-12T18:30:00Z");
  const win = (o: Record<string, unknown> = {}) => ({ id: "w", scope: "app" as const, appId: "a1", monitorId: null, startsAt: new Date("2026-10-12T18:00:00Z"), durationMin: 60, weekly: false, note: null, ...o });
  it("covers a heartbeat by its app, its own id or an all-monitors window, only while the window runs", () => {
    expect(heartbeatMaintenance([win()], at)("hb1", "a1")).toBe(true);
    expect(heartbeatMaintenance([win()], at)("hb1", "a2")).toBe(false);
    expect(heartbeatMaintenance([win({ scope: "monitor", appId: null, monitorId: "hb1" })], at)("hb1", "a1")).toBe(true);
    expect(heartbeatMaintenance([win({ scope: "monitor", appId: null, monitorId: "hb1" })], at)("hb2", "a1")).toBe(false);
    expect(heartbeatMaintenance([win({ scope: "all", appId: null })], at)("hb1", "a9")).toBe(true);
    expect(heartbeatMaintenance([win()], new Date("2026-10-12T19:00:00Z"))("hb1", "a1")).toBe(false);
    expect(heartbeatMaintenance([], at)("hb1", "a1")).toBe(false);
  });
  it("marks the heartbeat's checks row in_maintenance while its state still moves to down", async () => {
    const hbRow = {
      id: "hb1", resourceId: "a1", kind: "heartbeat", name: "backup job", url: "heartbeat:backup-job", state: "warn", failStreak: 1, periodS: 3600, graceS: 600,
      lastPingAt: new Date(at.getTime() - 5000_000), lastPingKind: "ok", createdAt: new Date("2026-10-01T00:00:00Z"), paused: false, ownerPaused: false,
    };
    const f = fakeDb([[{ m: hbRow }]], [[{ id: "hb1" }]]);
    h.current = f;
    expect(await taskHeartbeats(at, heartbeatMaintenance([win()], at))).toBe(1);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "err" });
    expect(payloadOf(insertsInto(f, checks)[0].calls)).toEqual([expect.objectContaining({ monitorId: "hb1", ok: false, inMaintenance: true })]);
  });
});

describe("taskChecks: body rules (U2)", () => {
  it("hands each monitor's keyword or JSON rule to the check, and keeps the error it came back with", async () => {
    const t = table([row("m1", { bodyContains: "ok" }), row("m2", { jsonPath: "status", jsonEquals: "up" }), row("m3")]);
    const f = fakeDb([[...t.byId.values()].map((m) => ({ m: { ...m }, app }))], [t.update, t.update, t.update]);
    h.current = f;
    const miss: CheckResult = { ok: false, statusCode: 200, latencyMs: 40, error: "Keyword not found" };
    h.checkUrl.mockImplementation(async (url: string) => (url.endsWith("/m1") ? miss : { ok: true, statusCode: 200, latencyMs: 40, error: null }));
    await taskChecks(new Date("2026-10-12T09:01:00Z"), Date.now() + 20_000, [], false);
    const rules = Object.fromEntries((h.checkUrl.mock.calls as [string, { body: unknown }][]).map(([url, o]) => [url.slice(-2), o.body]));
    expect(rules).toEqual({ m1: { kind: "contains", text: "ok" }, m2: { kind: "json", path: "status", equals: "up" }, m3: null });
    expect(t.byId.get("m1")).toMatchObject({ lastStatus: 200, lastError: "Keyword not found", failStreak: 1 });
    expect(t.byId.get("m3")).toMatchObject({ lastError: null });
  });

  it("reads only HTTP monitors, so a heartbeat is never fetched", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    await taskChecks(new Date(), Date.now() + 20_000, [], false);
    const where = f.queries[0].find((c) => c.method === "where")!.args[0] as { getSQL: () => unknown };
    const q = new PgDialect().sqlToQuery(where.getSQL() as never);
    expect(q.sql).toContain('"monitors"."kind" = $');
    expect(q.params).toContain("http");
  });
});

describe("taskChecks: rotation (final review I3)", () => {
  it("reads monitors least recently checked first, never-checked ones before all", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    await taskChecks(new Date(), Date.now() + 20_000, [], false);
    const order = f.queries[0].find((c) => c.method === "orderBy")!.args;
    expect(new PgDialect().sqlToQuery((order[0] as { getSQL: () => unknown }).getSQL() as never).sql).toBe('"ops"."monitors"."last_checked_at" asc nulls first');
  });

  it("with 20 monitors at 10 s timeouts, the ones a run skipped are checked first by the next run", async () => {
    const base = new Date("2026-10-12T09:00:00Z").getTime();
    const t = table(Array.from({ length: 20 }, (_, i) => row(`m${String(i).padStart(2, "0")}`, { lastCheckedAt: new Date(base + i * 1000) })));
    // What the SQL ORDER BY does: last_checked_at asc nulls first, then id.
    const listed = () => [...t.byId.values()]
      .sort((a, b) => (a.lastCheckedAt?.getTime() ?? -Infinity) - (b.lastCheckedAt?.getTime() ?? -Infinity) || a.id.localeCompare(b.id))
      .map((m) => ({ m: { ...m }, app }));
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // Each check started uses up 4 s of the run's 20 s, so a run gets through 5 monitors and skips the rest.
    const checked: string[] = [];
    h.checkUrl.mockImplementation(async (url: string) => {
      clock += 4000;
      checked.push(url.slice(url.lastIndexOf("/") + 1));
      return { ok: true, statusCode: 200, latencyMs: 50, error: null };
    });

    const run = async (at: Date) => {
      clock = 0;
      checked.length = 0;
      const f = fakeDb([listed], Array.from({ length: 20 }, () => t.update));
      h.current = f;
      const errors: string[] = [];
      await taskChecks(at, 20_000, errors, false);
      return { first: [...checked], errors };
    };

    const one = await run(new Date(base + 60_000));
    expect(one.first).toEqual(["m00", "m01", "m02", "m03", "m04"]);
    expect(one.errors).toEqual(["checks: 15 monitors skipped, time budget used"]);
    const two = await run(new Date(base + 120_000));
    expect(two.first).toEqual(["m05", "m06", "m07", "m08", "m09"]);
    const three = await run(new Date(base + 180_000));
    expect(three.first).toEqual(["m10", "m11", "m12", "m13", "m14"]);
  });
});

describe("runMainTasks (5b final review I1): slow HTTP checks can't starve the heartbeats", () => {
  it("still recomputes heartbeats when every check runs past the deadline, and skips only what comes after", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const workDeadline = BUDGET_MS - ALERTS_RESERVE_MS;
    // The run's own order: the minute tasks plus the first two late slower tasks, as after a deploy.
    const due = dueTasks({}, new Date("2026-10-12T10:17:01Z"), false).filter((t) => !POST_TASKS.includes(t));
    const t = table([row("m1"), row("m2"), row("m3")]);
    h.current = fakeDb([[...t.byId.values()].map((m) => ({ m: { ...m }, app }))], [t.update, t.update, t.update]);
    // A broad outage: each check hangs until its timeout, which is cut to the deadline.
    h.checkUrl.mockImplementation(async () => {
      clock = workDeadline + 500;
      return { ok: false, statusCode: null, latencyMs: null, error: "No answer within 10 s" } satisfies CheckResult;
    });
    const heartbeats = vi.fn(async () => 0);
    const errors: string[] = [];
    const { done, tried } = await runMainTasks(due, workDeadline, errors, async (task) => {
      if (task === "checks") await taskChecks(new Date(), workDeadline, errors, false);
      if (task === "heartbeats") await heartbeats();
    });
    expect(heartbeats).toHaveBeenCalledTimes(1);
    expect(errors.some((e) => e.startsWith("heartbeats:"))).toBe(false);
    expect(errors).toContain("vercel: skipped, time budget used");
    expect(done).toEqual(["heartbeats", "checks"]);
    expect(tried).toEqual(["heartbeats", "checks"]);
  });
  it("defers a task that doesn't fit (no error) and reports one that throws", async () => {
    const errors: string[] = [];
    const deadline = Date.now() + 5_000; // logs needs 9 s
    const { done, tried } = await runMainTasks(["heartbeats", "logs", "vercel"], deadline, errors, async (task) => {
      if (task === "vercel") throw new Error("boom");
    });
    expect(done).toEqual(["heartbeats"]);
    expect(tried).toEqual(["heartbeats", "vercel"]);
    expect(errors).toEqual(["vercel: boom"]);
  });
});

describe("settleRun (stage 4 review I1): the long tasks' last run is saved before anything that can throw", () => {
  const started = new Date("2026-10-12T09:00:00Z");
  const mk = () => {
    const order: string[] = [];
    const deps = {
      writeLastRun: vi.fn(async () => { order.push("write"); }),
      refreshApps: vi.fn(async () => { order.push("apps"); }),
      refreshNetwork: vi.fn(async () => { order.push("network"); }),
    };
    return { order, deps };
  };

  it("saves lastRun for every task that ran, before the derivations, keeping older entries", async () => {
    const { order, deps } = mk();
    await settleRun({ lastRun: { eol: "old" }, done: ["checks", "cloudflare"], started, errors: [] }, deps);
    expect(order).toEqual(["write", "apps", "network"]);
    expect(deps.writeLastRun).toHaveBeenCalledWith({ eol: "old", checks: started.toISOString(), cloudflare: started.toISOString() });
  });
  it("a throw in refreshNetworkStates is reported, not rethrown, and lastRun was already saved", async () => {
    const { order, deps } = mk();
    deps.refreshNetwork.mockRejectedValueOnce(new Error("FK violation"));
    const errors: string[] = [];
    await expect(settleRun({ lastRun: {}, done: ["cloudflare", "tls"], started, errors }, deps)).resolves.toBeUndefined();
    expect(order).toEqual(["write", "apps"]); // the network step threw after both
    expect(deps.writeLastRun).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^network-states: /);
  });
  it("a throw in refreshAppSnapshots doesn't stop the network step or lose lastRun", async () => {
    const { deps } = mk();
    deps.refreshApps.mockRejectedValueOnce(new Error("db down"));
    const errors: string[] = [];
    await settleRun({ lastRun: {}, done: ["checks", "rdap"], started, errors }, deps);
    expect(deps.writeLastRun).toHaveBeenCalledWith({ checks: started.toISOString(), rdap: started.toISOString() });
    expect(deps.refreshNetwork).toHaveBeenCalled();
    expect(errors[0]).toMatch(/^app-snapshots: /);
  });
  it("only derives network states when a network task ran", async () => {
    const { deps } = mk();
    await settleRun({ lastRun: {}, done: ["checks", "vercel"], started, errors: [] }, deps);
    expect(deps.refreshNetwork).not.toHaveBeenCalled();
  });
});

describe("settleRun (perf P3): the cached reads of what the run wrote are expired, after the writes", () => {
  const started = new Date("2026-10-13T01:00:00Z");
  const deps = (order: string[]) => ({
    writeLastRun: vi.fn(async () => { order.push("write"); }),
    refreshApps: vi.fn(async () => { order.push("apps"); }),
    refreshNetwork: vi.fn(async () => { order.push("network"); }),
  });
  it("expires each written area's tag at once through next/cache, last", async () => {
    const order: string[] = [];
    h.revalidateTag.mockImplementation((tag: string) => { order.push(tag); });
    await settleRun({ lastRun: {}, done: ["checks", "supabase", "cloudflare", "status"], started, errors: [] }, deps(order));
    expect(order).toEqual(["write", "apps", "network", "db:supabase", "net:zones", "net:domains", "status"]);
    expect(h.revalidateTag).toHaveBeenCalledWith("db:supabase", { expire: 0 });
  });
  it("counts a task that threw (it may have written part of its rows), not one that never started", async () => {
    await settleRun({ lastRun: {}, done: ["checks"], tried: ["checks", "neon"], started, errors: [] }, deps([]));
    expect(h.revalidateTag.mock.calls).toEqual([["db:neon", { expire: 0 }]]);
  });
  it("expires nothing after a run of real-time tasks only, and still expires when a derivation threw", async () => {
    await settleRun({ lastRun: {}, done: ["checks", "vercel", "alerts"], started, errors: [] }, deps([]));
    expect(h.revalidateTag).not.toHaveBeenCalled();
    const d = deps([]);
    d.refreshNetwork.mockRejectedValueOnce(new Error("db down"));
    await settleRun({ lastRun: {}, done: ["tls"], started, errors: [] }, d);
    expect(h.revalidateTag).toHaveBeenCalledWith("net:domains", { expire: 0 });
  });
  it("an EOL-only run still rewrites zone and domain states, so both network tags are expired (review m1)", async () => {
    const order: string[] = [];
    h.revalidateTag.mockImplementation((tag: string) => { order.push(tag); });
    await settleRun({ lastRun: {}, done: ["eol"], started, errors: [] }, deps(order));
    expect(order).toEqual(["write", "apps", "network", "net:zones", "net:domains"]);
  });
  it("expires even when saving lastRun threw, since the tasks had written before it", async () => {
    const d = deps([]);
    d.writeLastRun.mockRejectedValueOnce(new Error("db down"));
    await expect(settleRun({ lastRun: {}, done: ["firebase"], started, errors: [] }, d)).rejects.toThrow("db down");
    expect(h.revalidateTag).toHaveBeenCalledWith("db:firebase", { expire: 0 });
  });
});

describe("runPostTasks (stage 5 review I10): the alert rules run last, each step caught on its own", () => {
  const mk = () => ({
    evaluate: vi.fn(async () => undefined),
    deliver: vi.fn(async () => ({ sent: 0, dropped: 0 })),
    digest: vi.fn(async () => undefined),
  });
  const soon = () => Date.now() + 15_000;

  it("evaluates, then delivers, then checks the digest, and reports what ran", async () => {
    const deps = mk();
    const errors: string[] = [];
    expect(await runPostTasks(["alerts", "digest"], soon(), errors, deps as never)).toEqual(["alerts", "digest"]);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
  it("an evaluation error doesn't hold back notices already queued", async () => {
    const deps = mk();
    deps.evaluate.mockRejectedValueOnce(new Error("bad rule"));
    const errors: string[] = [];
    expect(await runPostTasks(["alerts"], soon(), errors, deps as never)).toEqual([]);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["alerts: bad rule"]);
  });
  it("a delivery error is its own line", async () => {
    const deps = mk();
    deps.deliver.mockRejectedValueOnce(new Error("db down"));
    const errors: string[] = [];
    await runPostTasks(["alerts"], soon(), errors, deps as never);
    expect(errors).toEqual(["notify: db down"]);
  });
  it("skips the rules once the run is over time, and defers the digest when it doesn't fit", async () => {
    const deps = mk();
    const errors: string[] = [];
    expect(await runPostTasks(["alerts", "digest"], Date.now() - 1, errors, deps as never)).toEqual([]);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.digest).not.toHaveBeenCalled();
    expect(errors).toEqual(["alerts: skipped, time budget used"]);
    expect(await runPostTasks(["digest"], Date.now() + 3_000, [], deps as never)).toEqual([]);
  });
});
