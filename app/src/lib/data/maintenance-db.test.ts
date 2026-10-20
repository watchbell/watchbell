import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceWindows } from "@/db/schema";
import { fakeDb, limitOf, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { activeWindows, createWindow, deleteWindow, listRawWindows, listWindows, updateWindow } from "./maintenance-db";

const APP = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const MON = "7a1e5d2f-8d66-4b1c-8e3f-2b3c4d5e6f70";
const start = new Date("2026-10-12T18:00:00Z"); // Tue 13 Oct 01:00 WIB
const stored = (o: Record<string, unknown> = {}) => ({
  id: "w1", scope: "app", resourceId: APP, monitorId: null, startsAt: start, durationMin: 60, weekly: false, note: null,
  createdBy: null, createdAt: start, updatedAt: start, ...o,
});
const use = (reads: unknown[][], writes: unknown[][] = []) => {
  const f = fakeDb(reads, writes);
  h.current = f;
  return f;
};
const sqlOf = (e: { getSQL: () => unknown }) => new PgDialect().sqlToQuery(e.getSQL() as never).sql;
const values = { scope: "app" as const, appId: APP, monitorId: null, startsAt: start, durationMin: 60, weekly: false, note: "DNS move" };

beforeEach(() => { h.current = null; });

describe("reads", () => {
  it("listRawWindows reads at most 20 rows, oldest start first, as Windows with the app as appId", async () => {
    const f = use([[stored()]]);
    expect(await listRawWindows()).toEqual([{ id: "w1", scope: "app", appId: APP, monitorId: null, startsAt: start, durationMin: 60, weekly: false, note: null }]);
    expect(limitOf(f.queries[0])).toBe(20);
  });
  it("listRawWindows reads only windows that can still apply: weekly ones, and one-offs until they end (5b final review M6)", async () => {
    const f = use([[]]);
    await listRawWindows();
    expect(sqlOf(whereOf(f.queries[0])!)).toMatch(/"weekly" or .*"starts_at" \+ .*"duration_min" \* interval '1 minute' > now\(\)/);
  });
  it("activeWindows keeps the ones covering now", async () => {
    use([[stored(), stored({ id: "w2", startsAt: new Date("2026-10-20T00:00:00Z") })]]);
    expect((await activeWindows(new Date("2026-10-12T18:30:00Z"))).map((w) => w.id)).toEqual(["w1"]);
  });
  it("listWindows names what each window applies to", async () => {
    use([[
      { w: stored({ id: "a", scope: "all", resourceId: null }), appName: null, monApp: null, monUrl: null, monKind: null, monName: null },
      { w: stored({ id: "b" }), appName: "webs-ticketer", monApp: null, monUrl: null, monKind: null, monName: null },
      { w: stored({ id: "c", scope: "monitor", resourceId: null, monitorId: MON }), appName: null, monApp: "web", monUrl: "https://web.example.com/api/health", monKind: "http", monName: null },
      { w: stored({ id: "d", scope: "monitor", resourceId: null, monitorId: MON }), appName: null, monApp: "web", monUrl: "heartbeat:backup-job", monKind: "heartbeat", monName: "backup job" },
    ]]);
    expect((await listWindows()).map((r) => r.target)).toEqual(["All monitors", "webs-ticketer", "web/api/health", "web · backup job"]);
  });
  it("listWindows reads the live windows first, then the latest ended ones, and shows them by start (5b final review M6)", async () => {
    const named = (id: string, startsAt: Date) => ({ w: stored({ id, startsAt }), appName: "web", monApp: null, monUrl: null, monKind: null, monName: null });
    const f = use([[named("live", new Date("2026-10-20T00:00:00Z")), named("over", new Date("2026-10-01T00:00:00Z")), named("older", new Date("2026-09-01T00:00:00Z"))]]);
    expect((await listWindows()).map((r) => r.id)).toEqual(["older", "over", "live"]);
    expect(limitOf(f.queries[0])).toBe(40);
    const order = f.queries[0].find((c) => c.method === "orderBy")!.args.map((a) => sqlOf(a as never));
    expect(order[0]).toMatch(/interval '1 minute' > now\(\)\) desc$/);
    expect(order[1]).toMatch(/"starts_at" desc$/);
  });
});

describe("createWindow", () => {
  it("adds a window under the lock when there are fewer than 20 and the app exists, and says so for the audit trail", async () => {
    const f = use([[{ n: 3 }], [{ id: APP, name: "webs-ticketer" }]], [[{ id: "w9" }]]);
    expect(await createWindow(values, "user-1")).toEqual({
      ok: true, message: "Maintenance window added.", audit: { message: "Maintenance window added: webs-ticketer", resourceId: APP },
    });
    expect(f.executes()).toBe(1);
    const ins = f.writes.find((w) => w.kind === "insert" && w.table === maintenanceWindows)!;
    expect(payloadOf(ins.calls)).toEqual({ scope: "app", resourceId: APP, monitorId: null, startsAt: start, durationMin: 60, weekly: false, note: "DNS move", createdBy: "user-1" });
  });
  it("refuses the 21st window", async () => {
    const f = use([[{ n: 20 }]]);
    expect(await createWindow(values, "user-1")).toEqual({ ok: false, error: "You can have at most 20 maintenance windows. Delete one first." });
    expect(f.writes).toEqual([]);
  });
  it("counts only the windows that haven't ended toward the cap (5b final review M6)", async () => {
    const f = use([[{ n: 19 }], [{ id: APP, name: "webs-ticketer" }]], [[{ id: "w9" }]]);
    expect(await createWindow(values, "user-1")).toMatchObject({ ok: true });
    expect(sqlOf(whereOf(f.queries[0])!)).toMatch(/"weekly" or .*interval '1 minute' > now\(\)/);
  });
  it("refuses an app or monitor that no longer exists", async () => {
    use([[{ n: 0 }], []]);
    expect(await createWindow(values, "u")).toEqual({ ok: false, error: "That application no longer exists." });
    use([[{ n: 0 }], []]);
    expect(await createWindow({ ...values, scope: "monitor", appId: null, monitorId: MON }, "u")).toEqual({ ok: false, error: "That monitor no longer exists." });
  });
  it("needs no lookup for all monitors, and names a monitor by app and path", async () => {
    let f = use([[{ n: 0 }]], [[{ id: "w9" }]]);
    expect(await createWindow({ ...values, scope: "all", appId: null }, "u")).toMatchObject({ ok: true, audit: { message: "Maintenance window added: All monitors", resourceId: null } });
    expect(f.queries).toHaveLength(1);
    f = use([[{ n: 0 }], [{ appId: APP, appName: "web", url: "https://web.example.com/api/health", kind: "http", name: null }]], [[{ id: "w9" }]]);
    expect(await createWindow({ ...values, scope: "monitor", appId: null, monitorId: MON }, "u")).toMatchObject({ ok: true, audit: { message: "Maintenance window added: web/api/health", resourceId: APP } });
    expect(f.writes).toHaveLength(1);
  });
});

describe("updateWindow and deleteWindow", () => {
  it("saves the new values on the row by id", async () => {
    const f = use([[{ n: 3 }], [{ id: APP, name: "webs-ticketer" }]], [[{ id: "w1" }]]);
    expect(await updateWindow("w1", values)).toEqual({ ok: true, message: "Maintenance window saved.", audit: { message: "Maintenance window changed: webs-ticketer", resourceId: APP } });
    const up = f.writes.find((w) => w.kind === "update")!;
    expect(payloadOf(up.calls)).toMatchObject({ scope: "app", resourceId: APP, monitorId: null, durationMin: 60, note: "DNS move", updatedAt: expect.any(Date) });
    expect(new PgDialect().sqlToQuery(whereOf(up.calls)!.getSQL() as never).params).toEqual(["w1"]);
  });
  it("says so when the window is gone", async () => {
    use([[{ n: 3 }], [{ id: APP, name: "webs-ticketer" }]], [[]]);
    expect(await updateWindow("w1", values)).toEqual({ ok: false, error: "That maintenance window no longer exists." });
    use([[]]);
    expect(await deleteWindow("w1")).toEqual({ ok: false, error: "That maintenance window no longer exists." });
  });
  it("refuses to bring an ended window back when 20 others are still live, counted under the lock (5b final review M6)", async () => {
    const f = use([[{ n: 20 }]]);
    expect(await updateWindow("w1", values)).toEqual({ ok: false, error: "You can have at most 20 maintenance windows. Delete one first." });
    expect(f.executes()).toBe(1);
    expect(f.writes).toEqual([]);
    const q = new PgDialect().sqlToQuery(whereOf(f.queries[0])!.getSQL() as never);
    expect(q.sql).toMatch(/"id" <> \$\d+/);
    expect(q.params).toContain("w1");
    expect(q.sql).toMatch(/interval '1 minute' > now\(\)/);
  });
  it("deletes by id and names it for the audit trail", async () => {
    const f = use([[{ w: stored(), appName: "webs-ticketer", monApp: null, monUrl: null, monKind: null, monName: null, monAppId: null }]], [[{ id: "w1" }]]);
    expect(await deleteWindow("w1")).toEqual({ ok: true, message: "Maintenance window deleted.", audit: { message: "Maintenance window deleted: webs-ticketer", resourceId: APP } });
    expect(f.writes.map((w) => [w.kind, w.table])).toEqual([["delete", maintenanceWindows]]);
  });
});
