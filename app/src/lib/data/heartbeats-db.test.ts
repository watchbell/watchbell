import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checks, monitors } from "@/db/schema";
import { tokenHash } from "@/lib/heartbeat-token";
import { LIMITS } from "@/lib/rate-limit";
import { fakeDb, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  limit: vi.fn(),
  recordEvents: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));

import { recordPing, taskHeartbeats } from "./heartbeats-db";

const T = "hb_0123456789abcdef0123456789abcdef";
const now = new Date("2026-10-13T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const sqlOf = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);
const use = (reads: unknown[][], writes: unknown[][] = []) => {
  const f = fakeDb(reads, writes);
  h.current = f;
  return f;
};

beforeEach(() => {
  h.current = null;
  h.limit.mockReset();
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordEvents.mockReset();
});

describe("recordPing (B2)", () => {
  it("looks the token up by its sha256 only, among heartbeats, and writes nothing for an unknown one", async () => {
    const f = use([[]]);
    expect(await recordPing(T, "ok", now)).toEqual({ status: "unknown" });
    const q = sqlOf(f.queries[0]);
    expect(q.params).toContain(tokenHash(T));
    expect(q.params).toContain("heartbeat");
    expect(JSON.stringify(q.params)).not.toContain(T);
    expect(f.writes).toEqual([]);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it("records the ping kind and time on a known heartbeat, counted against the token's hash", async () => {
    const f = use([[{ id: "m1" }]]);
    expect(await recordPing(T, "fail", now)).toEqual({ status: "ok" });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.ping, tokenHash(T));
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].table).toBe(monitors);
    expect(payloadOf(f.writes[0].calls)).toEqual({ lastPingAt: now, lastPingKind: "fail", updatedAt: now });
  });

  it("writes nothing past 60 pings in 10 minutes", async () => {
    const f = use([[{ id: "m1" }]]);
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await recordPing(T, "ok", now)).toEqual({ status: "limited", retryAfter: 120 });
    expect(f.writes).toEqual([]);
  });
});

const hb = (over: Record<string, unknown> = {}) => ({
  id: "m1", resourceId: "a1", kind: "heartbeat", name: "backup job", url: "heartbeat:backup-job", state: "ok", failStreak: 0,
  periodS: 3600, graceS: 600, lastPingAt: ago(600), lastPingKind: "ok", createdAt: ago(86_400), paused: false, ownerPaused: false, ...over,
});

describe("taskHeartbeats", () => {
  it("reads only the active heartbeats of watched apps", async () => {
    const f = use([[]]);
    expect(await taskHeartbeats(now)).toBe(0);
    const q = sqlOf(f.queries[0]);
    expect(q.sql).toContain('"kind" = $');
    expect(q.params).toContain("heartbeat");
    expect(q.sql).toContain('"owner_paused" = $');
    expect(q.sql).toContain('"gone_at" is null');
  });

  it("stores the state, one check per heartbeat and a down event with the reason", async () => {
    const f = use([[{ m: hb({ state: "warn", failStreak: 1, lastPingAt: ago(5000) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now)).toBe(1);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "err", failStreak: 3, lastCheckedAt: now, lastError: "Down · no ping for 1 h", stateSince: now });
    expect(f.writes[1].table).toBe(checks);
    expect(payloadOf(f.writes[1].calls)).toEqual([{ monitorId: "m1", at: now, ok: false, statusCode: null, latencyMs: null, error: "Down · no ping for 1 h", inMaintenance: false }]);
    expect(h.recordEvents.mock.calls[0][0]).toEqual([expect.objectContaining({ kind: "err", message: "Monitor down", detail: "Down · no ping for 1 h", resourceId: "a1" })]);
  });

  it("counts a late heartbeat as up in the checks and clears the error once it pings again", async () => {
    const f = use([[{ m: hb({ lastPingAt: ago(3900) }) }, { m: hb({ id: "m2", state: "err", failStreak: 3, lastPingAt: ago(60) }) }]], [[{ id: "m1" }], [{ id: "m2" }]]);
    expect(await taskHeartbeats(now)).toBe(2);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "warn", lastError: "Late · last ping 1 h ago" });
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ state: "ok", failStreak: 0, lastError: null });
    expect((payloadOf(f.writes[2].calls) as unknown as { ok: boolean }[]).map((r) => r.ok)).toEqual([true, true]);
    expect(h.recordEvents.mock.calls[0][0]).toEqual([
      expect.objectContaining({ kind: "warn", detail: "Late · last ping 1 h ago" }),
      expect.objectContaining({ kind: "ok", detail: "backup job pinged again" }),
    ]);
  });

  it("leaves a heartbeat that is still waiting for its first ping alone", async () => {
    const f = use([[{ m: hb({ state: "unknown", lastPingAt: null, lastPingKind: null, createdAt: ago(60) }) }]]);
    expect(await taskHeartbeats(now)).toBe(0);
    expect(f.writes).toEqual([]);
  });

  it("writes the down event of a heartbeat that never got its first ping (5b final review M2)", async () => {
    use([[{ m: hb({ state: "unknown", lastPingAt: null, lastPingKind: null, createdAt: ago(86_400) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now)).toBe(1);
    expect(h.recordEvents.mock.calls[0][0]).toEqual([expect.objectContaining({ kind: "err", message: "Monitor down", detail: "Down · never pinged" })]);
  });

  it("on a forced run, skips a heartbeat recomputed under 50 s ago, so Refresh now adds no extra checks row (5b final review M3)", async () => {
    const f = use([[{ m: hb({ lastCheckedAt: ago(30) }) }, { m: hb({ id: "m2", lastCheckedAt: ago(60) }) }]], [[{ id: "m2" }]]);
    expect(await taskHeartbeats(now, () => false, true)).toBe(1);
    expect(f.writes.filter((w) => w.table === monitors)).toHaveLength(1);
    expect(payloadOf(f.writes[1].calls)).toEqual([expect.objectContaining({ monitorId: "m2" })]);
  });

  it("a test ping (onlyId) recomputes that one heartbeat at once, but adds a checks row only after 50 s", async () => {
    const f = use([[{ m: hb({ state: "unknown", lastCheckedAt: ago(20), lastPingAt: ago(1) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now, () => false, true, "m1")).toBe(0);
    expect(sqlOf(f.queries[0]).params).toContain("m1");
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ state: "ok", lastCheckedAt: now });
    expect(f.writes.filter((w) => w.table === checks)).toEqual([]);
    const g = use([[{ m: hb({ state: "unknown", lastCheckedAt: ago(90), lastPingAt: ago(1) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now, () => false, true, "m1")).toBe(1);
    expect(g.writes.filter((w) => w.table === checks)).toHaveLength(1);
  });

  it("a scheduled run recomputes every heartbeat, however recently", async () => {
    use([[{ m: hb({ lastCheckedAt: ago(30) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now)).toBe(1);
    use([[{ m: hb({ lastCheckedAt: ago(30) }) }]], [[{ id: "m1" }]]);
    expect(await taskHeartbeats(now, () => false, false)).toBe(1);
  });

  it("is a compare-and-set: a ping, edit or pause in between wins, and this run writes no check or event for it", async () => {
    const f = use([[{ m: hb({ lastPingAt: ago(5000), state: "warn" }) }]], [[]]);
    expect(await taskHeartbeats(now)).toBe(0);
    const q = sqlOf(f.writes[0].calls);
    expect(q.sql).toContain('"last_ping_at" = $');
    expect(q.sql).toContain('"period_s" = $');
    expect(q.sql).toContain('"grace_s" = $');
    expect(q.sql).toContain('"state" = $');
    expect(q.sql).toContain('"owner_paused" = $');
    expect(f.writes).toHaveLength(1);
    expect(h.recordEvents.mock.calls[0][0]).toEqual([]);
  });

  it("marks the checks taken inside a maintenance window", async () => {
    const f = use([[{ m: hb() }]], [[{ id: "m1" }]]);
    await taskHeartbeats(now, (id, app) => id === "m1" && app === "a1");
    expect(payloadOf(f.writes[1].calls)).toEqual([expect.objectContaining({ inMaintenance: true })]);
  });
});
