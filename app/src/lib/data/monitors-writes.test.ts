import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  checkUrl: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/collector/http-check", () => ({ checkUrl: h.checkUrl }));

import { tokenHash } from "@/lib/heartbeat-token";
import {
  appOptions, checkMonitorNow, createHeartbeat, createMonitor, deleteMonitor, recordTestPing, rotateToken, setAppMonitorsPaused, setMonitorPaused, updateHeartbeat, updateMonitor,
} from "./monitors-db";

const use = (results: unknown[][], writeResults: (unknown[] | Error)[] = []) => {
  const f = fakeDb(results, writeResults);
  h.current = f;
  return f;
};

const mon = (over: Record<string, unknown> = {}) => ({
  id: "m1", resourceId: "a1", url: "https://web.example.com/api/health", expectedStatus: 200, timeoutMs: 5000, intervalS: 60,
  paused: false, ownerPaused: false, state: "ok", stateSince: new Date("2026-10-12T00:00:00Z"), failStreak: 0,
  lastCheckedAt: null as Date | null, lastStatus: null, lastLatencyMs: null, lastError: null, kind: "http",
  bodyContains: null, jsonPath: null, jsonEquals: null, ...over,
});
const loaded = (m: Record<string, unknown> = {}, over: { watched?: boolean; goneAt?: Date | null } = {}) => [
  { m: mon(m), watched: over.watched ?? true, goneAt: over.goneAt ?? null },
];
const values = { url: "https://web.example.com/", expectedStatus: 200, timeoutMs: 5000, bodyContains: null, jsonPath: null, jsonEquals: null };

beforeEach(() => {
  h.current = null;
  h.checkUrl.mockReset();
});

const sqlOf = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);
const ONE = [{ id: "m1" }];

describe("setMonitorPaused", () => {
  it("pausing sets only the owner's flag, and says what it did for the audit trail", async () => {
    const f = use([loaded()]);
    const r = await setMonitorPaused("m1", true);
    expect(r).toEqual({
      ok: true, message: "Paused web.example.com/api/health. Its history is kept.",
      audit: { message: "Monitor paused: web.example.com/api/health", resourceId: "a1" },
    });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ ownerPaused: true });
    expect(payloadOf(f.writes[0].calls)).not.toHaveProperty("paused");
  });

  it("resuming a monitor of a watched app clears the owner's pause AND Sync's pause (controller ruling)", async () => {
    const f = use([loaded({ paused: true, ownerPaused: true }), [{ n: 3 }]], [ONE]);
    const r = await setMonitorPaused("m1", false);
    expect(r).toMatchObject({ ok: true, message: "Resumed web.example.com/api/health. First result within a minute.", audit: { message: "Monitor resumed: web.example.com/api/health" } });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ ownerPaused: false, paused: false, state: "unknown", failStreak: 0 });
  });

  it("takes the cap lock before counting, so two resumes can't both slip under 20", async () => {
    const f = use([loaded({ ownerPaused: true }), [{ n: 3 }]], [ONE]);
    await setMonitorPaused("m1", false);
    expect(f.executes()).toBe(1);
  });

  it("resuming a monitor of a gone app says it won't be checked, not that it waits for Sync (M-e)", async () => {
    use([loaded({ paused: true, ownerPaused: true }, { goneAt: new Date("2026-10-01T00:00:00Z") }), [{ n: 3 }]], [ONE]);
    expect(await setMonitorPaused("m1", false)).toMatchObject({ ok: true, message: "Resumed web.example.com/api/health. The app no longer exists at Vercel, so it won't be checked." });
  });

  it("resuming a monitor of an unwatched app leaves Sync's pause for Sync, and doesn't promise a check (M5)", async () => {
    const f = use([loaded({ paused: true, ownerPaused: true }, { watched: false }), [{ n: 3 }]], [ONE]);
    const r = await setMonitorPaused("m1", false);
    const set = payloadOf(f.writes[0].calls);
    expect(set).toMatchObject({ ownerPaused: false });
    expect(set).not.toHaveProperty("paused");
    expect(r).toMatchObject({ ok: true, message: "Resumed web.example.com/api/health. It's checked again once its app is watched." });
  });

  it("treats an app that has gone from the provider as unwatched", async () => {
    const f = use([loaded({ paused: true, ownerPaused: true }, { goneAt: new Date() }), [{ n: 3 }]], [ONE]);
    await setMonitorPaused("m1", false);
    expect(payloadOf(f.writes[0].calls)).not.toHaveProperty("paused");
  });

  it("refuses to resume past 20 active monitors, and writes nothing", async () => {
    const f = use([loaded({ ownerPaused: true }), [{ n: 20 }]]);
    const r = await setMonitorPaused("m1", false);
    expect(r).toEqual({ ok: false, error: "The console checks at most 20 monitors. Pause or delete one first." });
    expect(f.writes).toHaveLength(0);
  });

  it("Resume on a monitor that is already running changes nothing (final review M2)", async () => {
    const f = use([loaded({ state: "err", failStreak: 3 })]);
    expect(await setMonitorPaused("m1", false)).toEqual({ ok: true, message: "Already running." });
    expect(f.writes).toHaveLength(0);
    expect(f.executes()).toBe(0);
  });

  it("the resume write is conditional on the owner's pause, so a concurrent resume can't reset the state twice (M2)", async () => {
    const f = use([loaded({ ownerPaused: true }), [{ n: 3 }], [{ id: "m1" }]], [[]]);
    expect(await setMonitorPaused("m1", false)).toEqual({ ok: true, message: "Already running." });
    expect(sqlOf(f.writes[0].calls).sql).toMatch(/"owner_paused" = \$\d/);
    expect(sqlOf(f.writes[0].calls).params).toContain(true);
  });

  it("says the monitor is gone when it was deleted while the resume waited", async () => {
    use([loaded({ ownerPaused: true }), [{ n: 3 }], []], [[]]);
    expect(await setMonitorPaused("m1", false)).toEqual({ ok: false, error: "That monitor no longer exists." });
  });

  it("says so when the monitor is gone", async () => {
    use([[]]);
    expect(await setMonitorPaused("m1", true)).toEqual({ ok: false, error: "That monitor no longer exists." });
  });
});

describe("setAppMonitorsPaused", () => {
  it("pauses every monitor of the app", async () => {
    const f = use([[{ paused: false, ownerPaused: false }, { paused: false, ownerPaused: false }]]);
    expect(await setAppMonitorsPaused("a1", true)).toMatchObject({
      ok: true, message: "Paused 2 monitors. Their history is kept.", audit: { message: "Monitors paused: 2", resourceId: "a1" },
    });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ ownerPaused: true });
  });

  it("resuming a watched app clears both flags on the monitors the owner paused", async () => {
    const f = use([
      [{ paused: true, ownerPaused: true }, { paused: false, ownerPaused: true }, { paused: false, ownerPaused: false }],
      [{ watched: true, goneAt: null }],
      [{ n: 5 }],
    ]);
    const r = await setAppMonitorsPaused("a1", false);
    expect(r).toMatchObject({ ok: true, message: "Resumed 2 monitors. First results within a minute.", audit: { message: "Monitors resumed: 2", resourceId: "a1" } });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ ownerPaused: false, paused: false, state: "unknown" });
  });

  it("resuming a gone app says its monitors won't be checked (M-e)", async () => {
    use([[{ paused: true, ownerPaused: true }], [{ watched: true, goneAt: new Date("2026-10-01T00:00:00Z") }], [{ n: 5 }]]);
    expect(await setAppMonitorsPaused("a1", false)).toMatchObject({ ok: true, message: "Resumed 1 monitor. The app no longer exists at Vercel, so they won't be checked." });
  });

  it("resuming an unwatched app doesn't promise checks (M5)", async () => {
    use([[{ paused: true, ownerPaused: true }], [{ watched: false, goneAt: null }], [{ n: 5 }]]);
    expect(await setAppMonitorsPaused("a1", false)).toMatchObject({ ok: true, message: "Resumed 1 monitor. They're checked again once the app is watched." });
  });

  it("resuming counts Sync-paused monitors of the app against the limit", async () => {
    const f = use([[{ paused: true, ownerPaused: true }, { paused: true, ownerPaused: true }], [{ watched: true, goneAt: null }], [{ n: 19 }]]);
    expect((await setAppMonitorsPaused("a1", false)).ok).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it("has nothing to do for an app without monitors", async () => {
    use([[]]);
    expect(await setAppMonitorsPaused("a1", false)).toEqual({ ok: false, error: "This app has no monitors." });
  });
});

describe("createMonitor", () => {
  it("says a gone app no longer exists at Vercel instead of sending the owner to Sync (M5)", async () => {
    const f = use([[{ id: "a1", goneAt: new Date("2026-10-01T00:00:00Z") }]]);
    expect(await createMonitor("a1", values)).toEqual({ ok: false, error: "This app no longer exists at Vercel." });
    expect(f.writes).toHaveLength(0);
  });

  it("refuses an app that isn't watched", async () => {
    const f = use([[]]);
    expect(await createMonitor("a1", values)).toEqual({ ok: false, error: "That app isn't watched. Tick it in Connections → Sync first." });
    expect(f.writes).toHaveLength(0);
  });

  it("refuses the 21st active monitor", async () => {
    const f = use([[{ id: "a1" }], [{ n: 20 }]]);
    expect((await createMonitor("a1", values)).ok).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it("counts and inserts under one lock, so concurrent adds can't both pass the cap (M4)", async () => {
    const f = use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    await createMonitor("a1", values);
    expect(f.executes()).toBe(1);
  });

  it("tells a duplicate address from a new one", async () => {
    use([[{ id: "a1" }], [{ n: 3 }]], [[]]);
    expect(await createMonitor("a1", values)).toEqual({ ok: false, error: "This app already has a monitor for that address." });
  });

  it("adds it, with the mockup's toast text and an audit entry", async () => {
    const f = use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    expect(await createMonitor("a1", { ...values, url: "https://web.example.com/api/health" })).toEqual({
      ok: true, message: "Monitoring web.example.com/api/health. First result within a minute.",
      audit: { message: "Monitor added: web.example.com/api/health", resourceId: "a1" },
    });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ resourceId: "a1", expectedStatus: 200, timeoutMs: 5000 });
  });

  it("stores an HTTP monitor with its keyword or JSON rule", async () => {
    const f = use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    await createMonitor("a1", { ...values, bodyContains: "ok" });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ kind: "http", bodyContains: "ok", jsonPath: null, jsonEquals: null });
    const g = use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    await createMonitor("a1", { ...values, jsonPath: "checks.db", jsonEquals: "ok" });
    expect(payloadOf(g.writes[0].calls)).toMatchObject({ bodyContains: null, jsonPath: "checks.db", jsonEquals: "ok" });
  });

  it("keeps a query string (which can carry a token) out of the audit entry", async () => {
    use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    const r = await createMonitor("a1", { ...values, url: "https://web.example.com/health?token=s3cret" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });
});

describe("updateMonitor", () => {
  it("starts the state afresh when the address changes, and audits the old and the new address", async () => {
    const f = use([loaded({ failStreak: 2, state: "warn" }), []], [ONE]);
    const r = await updateMonitor("m1", values);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ url: "https://web.example.com/", state: "unknown", failStreak: 0, lastCheckedAt: null });
    expect(r).toMatchObject({ ok: true, message: "Checking web.example.com/ from the next run.", audit: { message: "Monitor edited: web.example.com/", detail: "was web.example.com/api/health", resourceId: "a1" } });
  });

  it("starts the state afresh when the body rule changes, clearing the old error", async () => {
    const f = use([loaded({ failStreak: 2, state: "warn", lastError: "Keyword not found", url: "https://web.example.com/" }), []], [ONE]);
    await updateMonitor("m1", { ...values, bodyContains: "ok" });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ bodyContains: "ok", state: "unknown", failStreak: 0, lastCheckedAt: null, lastError: null });
  });

  it("keeps the state when only the timeout changes", async () => {
    const f = use([loaded(), []], [ONE]);
    const r = await updateMonitor("m1", { ...values, url: "https://web.example.com/api/health", timeoutMs: 10_000 });
    const set = payloadOf(f.writes[0].calls);
    expect(set).toMatchObject({ timeoutMs: 10_000 });
    expect(set).not.toHaveProperty("state");
    expect(set).not.toHaveProperty("failStreak");
    expect(r).toMatchObject({ ok: true, audit: { message: "Monitor edited: web.example.com/api/health" } });
  });

  it("doesn't promise a check for a monitor the owner paused (final review M8)", async () => {
    use([loaded({ ownerPaused: true }), []], [ONE]);
    expect(await updateMonitor("m1", values)).toMatchObject({ ok: true, message: "Saved web.example.com/. It's checked again once you resume it." });
  });

  it("is a compare-and-set on the address and expected status it read (I1)", async () => {
    const f = use([loaded(), []], [ONE]);
    await updateMonitor("m1", values);
    const q = sqlOf(f.writes[0].calls);
    expect(q.sql).toMatch(/"url" = \$\d/);
    expect(q.sql).toMatch(/"expected_status" = \$\d/);
    expect(q.sql).toMatch(/"body_contains" is null/);
    expect(q.sql).toMatch(/"json_path" is null/);
    expect(q.sql).toMatch(/"json_equals" is null/);
    expect(q.params).toEqual(expect.arrayContaining(["m1", "https://web.example.com/api/health", 200]));
  });

  it("says so when another edit changed the monitor first, and when it was deleted meanwhile", async () => {
    use([loaded(), [], loaded({ url: "https://web.example.com/other" })], [[]]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "Someone else changed this monitor just now. Reopen it and try again." });
    use([loaded(), [], []], [[]]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "That monitor no longer exists." });
  });

  it("refuses an address the app already checks", async () => {
    const f = use([loaded(), [{ id: "m2" }]]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "This app already has a monitor for that address." });
    expect(f.writes).toHaveLength(0);
  });

  it("maps a unique-index clash that slips past the pre-check to the same message (M4)", async () => {
    use([loaded(), []], [Object.assign(new Error("duplicate key"), { code: "23505" })]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "This app already has a monitor for that address." });
  });

  it("maps a wrapped driver error the same way", async () => {
    use([loaded(), []], [Object.assign(new Error("Failed query"), { cause: { code: "23505" } })]);
    expect((await updateMonitor("m1", values)).ok).toBe(false);
  });

  it("lets other database errors through", async () => {
    use([loaded(), []], [new Error("connection lost")]);
    await expect(updateMonitor("m1", values)).rejects.toThrow("connection lost");
  });

  it("says a gone app no longer exists at Vercel (M5)", async () => {
    const f = use([loaded({ paused: true }, { goneAt: new Date("2026-10-01T00:00:00Z") })]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "This app no longer exists at Vercel." });
    expect(f.writes).toHaveLength(0);
  });

  it("requires the app to be watched, like Add does (M6)", async () => {
    const f = use([loaded({}, { watched: false })]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "That app isn't watched. Tick it in Connections → Sync first." });
    expect(f.writes).toHaveLength(0);
  });
});

describe("deleteMonitor", () => {
  it("is one guarded statement under the lock, and keeps the only monitor of a watched app", async () => {
    const f = use([loaded(), [{ id: "m1" }]], [[]]);
    const r = await deleteMonitor("m1");
    expect(r).toEqual({ ok: false, error: "This is the app's only monitor, and Sync would add it back. Pause it instead." });
    expect(f.executes()).toBe(1);
    expect(f.writes.map((w) => w.kind)).toEqual(["delete"]);
    const where = f.writes[0].calls.find((c) => c.method === "where")?.args[0] as { getSQL: () => unknown };
    expect(new PgDialect().sqlToQuery(where.getSQL() as never).sql).toMatch(/select count\(\*\)/i);
  });

  it("deletes the console row and audits it", async () => {
    const f = use([loaded()], [[{ id: "m1" }]]);
    expect(await deleteMonitor("m1")).toEqual({
      ok: true, message: "Deleted web.example.com/api/health.", audit: { message: "Monitor deleted: web.example.com/api/health", resourceId: "a1" },
    });
    expect(f.writes.map((w) => w.kind)).toEqual(["delete"]);
  });

  it("lets the last monitor of an unwatched app go, without the sibling guard", async () => {
    const f = use([loaded({}, { watched: false })], [[{ id: "m1" }]]);
    expect((await deleteMonitor("m1")).ok).toBe(true);
    const where = f.writes[0].calls.find((c) => c.method === "where")?.args[0] as { getSQL: () => unknown };
    expect(new PgDialect().sqlToQuery(where.getSQL() as never).sql).not.toMatch(/select count\(\*\)/i);
  });

  it("says so when a concurrent delete got there first", async () => {
    use([loaded({}, { watched: false })], [[]]);
    expect(await deleteMonitor("m1")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });

  it("on a watched app too, instead of calling it the app's only monitor (task 6 N3)", async () => {
    use([loaded(), []], [[]]);
    expect(await deleteMonitor("m1")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });
});

describe("checkMonitorNow", () => {
  const pass = { ok: true, statusCode: 200, latencyMs: 182, error: null };
  const ago = (s: number) => new Date(Date.now() - s * 1000);

  it("doesn't check a paused monitor", async () => {
    use([loaded({ ownerPaused: true })]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: false, error: "Paused monitors aren't checked. Resume it first." });
    expect(h.checkUrl).not.toHaveBeenCalled();
  });

  it("says a gone app's monitor can't be checked because the app no longer exists at Vercel (M5)", async () => {
    use([loaded({ paused: true }, { goneAt: new Date("2026-10-01T00:00:00Z") })]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: false, error: "This app no longer exists at Vercel." });
    expect(h.checkUrl).not.toHaveBeenCalled();
  });

  it("says an unwatched app's monitor isn't checked because the app isn't watched (M5)", async () => {
    use([loaded({ paused: true }, { watched: false })]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: false, error: "Its app isn't watched. Tick it in Connections → Sync first." });
  });

  it("counts a check like the collector does, without the collector's lease (task 6 M2): state first, then a checks row, no event without a change", async () => {
    const f = use([loaded({ state: "ok", failStreak: 0 })], [ONE]);
    h.checkUrl.mockResolvedValue(pass);
    const r = await checkMonitorNow("m1");
    expect(r).toEqual({
      ok: true, message: "Answered 200 in 182 ms.", passed: true, audit: { message: "Check now: web.example.com/api/health", resourceId: "a1" },
    });
    expect(f.writes.map((w) => w.kind)).toEqual(["update", "insert"]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "ok", failStreak: 0, lastStatus: 200, lastLatencyMs: 182 });
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ inMaintenance: false });
    expect(f.executes()).toBe(0);
  });

  it("marks the checks row in_maintenance inside a window on its app (U5), and still counts it on the monitor", async () => {
    const window = { id: "w1", scope: "app", resourceId: "a1", monitorId: null, startsAt: new Date(Date.now() - 60_000), durationMin: 30, weekly: false, note: null };
    const f = use([loaded({ state: "ok", failStreak: 0 }), [window]], [ONE]);
    h.checkUrl.mockResolvedValue(pass);
    await checkMonitorNow("m1");
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ lastStatus: 200 });
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ monitorId: "m1", inMaintenance: true });
  });

  it("reads the windows before it checks or writes anything, so a failed read leaves the monitor as it was (review M1)", async () => {
    const f = use([loaded(), new Error("db down") as never]);
    h.checkUrl.mockResolvedValue(pass);
    await expect(checkMonitorNow("m1")).rejects.toThrow("db down");
    expect(h.checkUrl).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("writes an event when the state changes, and reports a failed check as not passed", async () => {
    const f = use([loaded({ state: "ok", failStreak: 0 })], [ONE]);
    h.checkUrl.mockResolvedValue({ ok: false, statusCode: 502, latencyMs: 90, error: "HTTP 502" });
    const r = await checkMonitorNow("m1");
    expect(r).toMatchObject({ ok: true, message: "Failed: HTTP 502.", passed: false });
    // monitor update, checks row, then the event: a bump attempt (nothing to bump) and the insert (R2).
    expect(f.writes.map((w) => w.kind)).toEqual(["update", "insert", "update", "insert"]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "warn", failStreak: 1, lastStatus: 502 });
    expect(payloadOf(f.writes[3].calls)).toMatchObject({ reason: "MonitorDegraded", count: 1, message: "Monitor degraded" });
  });

  it("writes compare-and-set on the last check, state, fail streak and address it read (I1)", async () => {
    const at = ago(300);
    const f = use([loaded({ lastCheckedAt: at, failStreak: 2, state: "warn" })], [ONE]);
    h.checkUrl.mockResolvedValue(pass);
    await checkMonitorNow("m1");
    const q = sqlOf(f.writes[0].calls);
    expect(q.sql).toMatch(/"last_checked_at" = \$\d/);
    expect(q.sql).toMatch(/"fail_streak" = \$\d/);
    expect(q.params).toEqual(expect.arrayContaining(["m1", at.toISOString(), "warn", 2, "https://web.example.com/api/health", 200]));
  });

  it("matches a never-checked monitor with IS NULL", async () => {
    const f = use([loaded({ lastCheckedAt: null })], [ONE]);
    h.checkUrl.mockResolvedValue(pass);
    await checkMonitorNow("m1");
    expect(sqlOf(f.writes[0].calls).sql).toMatch(/"last_checked_at" is null/);
  });

  it("drops its result when a collector run wrote first, and shows that run's result instead (I1)", async () => {
    const f = use([
      loaded({ lastCheckedAt: ago(300), failStreak: 0 }),
      [], // maintenance windows
      loaded({ lastCheckedAt: ago(5), failStreak: 1, state: "warn", lastStatus: 502, lastLatencyMs: 90 }),
    ], [[]]);
    h.checkUrl.mockResolvedValue({ ok: false, statusCode: 502, latencyMs: 90, error: "HTTP 502" });
    const r = await checkMonitorNow("m1");
    expect(r).toEqual({ ok: true, message: "Checked 5s ago: failed (HTTP 502).", passed: false });
    expect(f.writes.map((w) => w.kind)).toEqual(["update"]);
  });

  it("says the monitor is gone when it was deleted during the check", async () => {
    use([loaded(), [], []], [[]]);
    h.checkUrl.mockResolvedValue(pass);
    expect(await checkMonitorNow("m1")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });

  it("shows the last result without fetching when the monitor was checked in the last 50 s (I2)", async () => {
    const f = use([loaded({ lastCheckedAt: ago(20), lastStatus: 200, lastLatencyMs: 380 })]);
    const r = await checkMonitorNow("m1");
    expect(r).toEqual({ ok: true, message: "Checked 20s ago: 200 in 380 ms.", passed: true });
    expect(h.checkUrl).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it("runs the monitor's keyword rule and words a missed keyword as the failure", async () => {
    const f = use([loaded({ bodyContains: "ok" })], [ONE]);
    h.checkUrl.mockResolvedValue({ ok: false, statusCode: 200, latencyMs: 90, error: "Keyword not found" });
    expect(await checkMonitorNow("m1")).toMatchObject({ ok: true, message: "Failed: Keyword not found.", passed: false });
    expect(h.checkUrl).toHaveBeenCalledWith("https://web.example.com/api/health", expect.objectContaining({ body: { kind: "contains", text: "ok" } }));
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ lastStatus: 200, lastError: "Keyword not found" });
  });

  it("a recent result that missed its keyword shows the saved error and isn't passed", async () => {
    use([loaded({ lastCheckedAt: ago(20), lastStatus: 200, lastLatencyMs: 80, lastError: "Keyword not found" })]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: true, message: "Checked 20s ago: failed (Keyword not found).", passed: false });
  });

  it("a recent failed result is not passed, so it isn't a success toast (final review M1)", async () => {
    use([loaded({ lastCheckedAt: ago(20), lastStatus: 500, lastLatencyMs: 80 })]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: true, message: "Checked 20s ago: failed (HTTP 500).", passed: false });
  });

  it("lets a check that throws through, writing nothing", async () => {
    const f = use([loaded()]);
    h.checkUrl.mockRejectedValue(new Error("boom"));
    await expect(checkMonitorNow("m1")).rejects.toThrow("boom");
    expect(f.writes).toHaveLength(0);
  });
});

describe("appOptions", () => {
  it("lists watched apps with the domain of their oldest monitor", async () => {
    use([
      [{ id: "a1", name: "web" }, { id: "a2", name: "api" }],
      [{ appId: "a1", url: "https://web.example.com/" }, { appId: "a1", url: "https://other.example.com/x" }],
    ]);
    const apps = await appOptions();
    expect(apps[0]).toEqual({ id: "a1", name: "web", domain: "web.example.com" });
    expect(apps[1]).toMatchObject({ id: "a2", name: "api" });
  });

  it("is empty when nothing is watched, without a second query", async () => {
    const f = use([[]]);
    expect(await appOptions()).toEqual([]);
    expect(f.queries).toHaveLength(1);
  });
});

// U3: heartbeats share the monitors table, so every monitor action knows which kind it is touching.
const hbRow = { kind: "heartbeat", url: "heartbeat:backup-job", name: "backup job", periodS: 3600, graceS: 600, tokenHash: "f".repeat(64) };
const hbValues = { name: "backup job", periodS: 86_400, graceS: 3600 };

describe("createHeartbeat (U3)", () => {
  it("stores only the token's hash, keyed by the name, waiting for its first ping, and hands the token back once", async () => {
    const f = use([[{ id: "a1" }], [{ n: 3 }]], [[{ id: "new" }]]);
    const r = await createHeartbeat("a1", hbValues);
    expect(r).toMatchObject({ ok: true, message: "Added backup job. It waits for the first ping.", audit: { message: "Heartbeat added: backup job", resourceId: "a1" } });
    const token = (r as { token: string }).token;
    expect(token).toMatch(/^hb_[0-9a-f]{32}$/);
    const row = payloadOf(f.writes[0].calls)!;
    expect(row).toEqual({
      resourceId: "a1", kind: "heartbeat", url: "heartbeat:backup-job", name: "backup job", tokenHash: tokenHash(token), periodS: 86_400, graceS: 3600, state: "unknown",
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify((r as { audit: unknown }).audit)).not.toContain(token);
    expect(f.executes()).toBe(1);
  });

  it("counts against the heartbeat cap, not the 20 HTTP checks", async () => {
    const f = use([[{ id: "a1" }], [{ n: 20 }]]);
    expect(await createHeartbeat("a1", hbValues)).toEqual({ ok: false, error: "The console keeps at most 20 heartbeats. Delete one first." });
    expect(f.writes).toHaveLength(0);
    expect(sqlOf(f.queries[1]).params).toContain("heartbeat");
  });

  it("refuses an app that isn't watched or is gone, and a name the app already has", async () => {
    use([[]]);
    expect(await createHeartbeat("a1", hbValues)).toMatchObject({ ok: false, error: "That app isn't watched. Tick it in Connections → Sync first." });
    use([[{ id: "a1", goneAt: new Date("2026-10-01T00:00:00Z") }]]);
    expect(await createHeartbeat("a1", hbValues)).toMatchObject({ ok: false, error: "This app no longer exists at Vercel." });
    use([[{ id: "a1" }], [{ n: 3 }]], [[]]);
    expect(await createHeartbeat("a1", hbValues)).toEqual({ ok: false, error: "This app already has a heartbeat with that name." });
  });
});

describe("updateHeartbeat (U3)", () => {
  it("saves the name, period and grace without resetting the state, and audits a rename", async () => {
    const f = use([loaded(hbRow), []], [ONE]);
    const r = await updateHeartbeat("m1", { name: "nightly backup", periodS: 86_400, graceS: 21_600 });
    expect(r).toEqual({ ok: true, message: "Saved nightly backup.", audit: { message: "Heartbeat edited: nightly backup", detail: "was backup job", resourceId: "a1" } });
    expect(payloadOf(f.writes[0].calls)).toEqual({ name: "nightly backup", url: "heartbeat:nightly-backup", periodS: 86_400, graceS: 21_600, updatedAt: expect.any(Date) });
  });

  it("refuses a name another heartbeat of the app has, and an HTTP check", async () => {
    use([loaded(hbRow), [{ id: "m2" }]]);
    expect(await updateHeartbeat("m1", hbValues)).toEqual({ ok: false, error: "This app already has a heartbeat with that name." });
    const f = use([loaded()]);
    expect(await updateHeartbeat("m1", hbValues)).toEqual({ ok: false, error: "That monitor isn't a heartbeat." });
    expect(f.writes).toHaveLength(0);
  });

  it("the HTTP edit refuses a heartbeat, so its row never gets a URL to fetch", async () => {
    const f = use([loaded(hbRow)]);
    expect(await updateMonitor("m1", values)).toEqual({ ok: false, error: "That monitor is a heartbeat. Edit it from its own menu." });
    expect(f.writes).toHaveLength(0);
  });
});

describe("rotateToken (U3: Show ping URL)", () => {
  it("replaces the stored hash with a new token's, so the old URL stops working, and returns the new token once", async () => {
    const f = use([loaded(hbRow)], [ONE]);
    const r = await rotateToken("m1");
    const token = (r as { token: string }).token;
    expect(r).toMatchObject({ ok: true, message: "New ping URL for backup job. The old one no longer works.", audit: { message: "Ping URL replaced: backup job", resourceId: "a1" } });
    expect(token).toMatch(/^hb_[0-9a-f]{32}$/);
    expect(payloadOf(f.writes[0].calls)).toEqual({ tokenHash: tokenHash(token), updatedAt: expect.any(Date) });
    expect(JSON.stringify((r as { audit: unknown }).audit)).not.toContain(token);
  });

  it("refuses an HTTP check and a deleted monitor", async () => {
    use([loaded()]);
    expect(await rotateToken("m1")).toEqual({ ok: false, error: "That monitor isn't a heartbeat." });
    use([[]]);
    expect(await rotateToken("m1")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });
});

describe("the other monitor actions on a heartbeat (U3)", () => {
  it("Check now refuses it without fetching anything", async () => {
    const f = use([loaded(hbRow)]);
    expect(await checkMonitorNow("m1")).toEqual({ ok: false, error: "The console doesn't check a heartbeat. It waits for your job's ping." });
    expect(h.checkUrl).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it("Pause and Resume name it, and resuming it doesn't count it against the HTTP cap", async () => {
    use([loaded(hbRow)]);
    expect(await setMonitorPaused("m1", true)).toMatchObject({ ok: true, message: "Paused backup job. Its history is kept.", audit: { message: "Monitor paused: backup job" } });
    const f = use([loaded({ ...hbRow, ownerPaused: true })], [ONE]);
    expect(await setMonitorPaused("m1", false)).toMatchObject({ ok: true, message: "Resumed backup job. First result within a minute." });
    expect(f.queries).toHaveLength(1); // the load only: no count
  });

  it("an app's Resume counts only its HTTP checks against the cap", async () => {
    use([
      [{ paused: false, ownerPaused: true, kind: "http" }, { paused: false, ownerPaused: true, kind: "heartbeat" }],
      [{ watched: true, goneAt: null }],
      [{ n: 19 }],
    ], [[]]);
    expect(await setAppMonitorsPaused("a1", false)).toMatchObject({ ok: true, message: "Resumed 2 monitors. First results within a minute." });
  });

  it("Delete lets a heartbeat go without the only-monitor guard, and names it", async () => {
    const f = use([loaded(hbRow)], [ONE]);
    expect(await deleteMonitor("m1")).toEqual({ ok: true, message: "Deleted backup job.", audit: { message: "Monitor deleted: backup job", resourceId: "a1" } });
    expect(sqlOf(f.writes[0].calls).sql).not.toMatch(/select count\(\*\)/i);
  });

  it("Add monitor's domains come from HTTP checks only", async () => {
    const f = use([[{ id: "a1", name: "web" }], [{ appId: "a1", url: "https://web.example.com/" }]]);
    await appOptions();
    expect(sqlOf(f.queries[1]).params).toContain("http");
  });
});

describe("recordTestPing (U3: Record a test ping)", () => {
  const at = new Date("2026-10-13T12:00:00Z");

  it("writes the ping columns by id, like the route, and marks the audit entry as a test", async () => {
    const f = use([loaded(hbRow)], [ONE]);
    const r = await recordTestPing("m1", "fail", at);
    expect(r).toMatchObject({ ok: true, audit: { message: "Test ping (fail) recorded for backup job", detail: "Test", resourceId: "a1" } });
    expect(payloadOf(f.writes[0].calls)).toEqual({ lastPingAt: at, lastPingKind: "fail", updatedAt: at });
  });

  it("refuses an HTTP check and a deleted monitor without writing", async () => {
    const f = use([loaded()]);
    expect(await recordTestPing("m1", "ok")).toEqual({ ok: false, error: "That monitor isn't a heartbeat." });
    expect(f.writes).toHaveLength(0);
    use([[]]);
    expect(await recordTestPing("m1", "ok")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });
});
