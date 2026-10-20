import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, linked: vi.fn(), windows: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./databases-db", () => ({ linkedDatabases: h.linked }));
vi.mock("./maintenance-db", () => ({ listRawWindows: h.windows }));

import { listApps } from "./apps-db";

const NOW = new Date("2026-10-12T05:00:00Z");
const app = (id: string, name: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  r: { id, name, goneAt: null, meta: { teamId: "team_a" } }, s: { state: "warn", stateSince: NOW, data }, sec: null, accStatus: "ok",
  ...extra,
});

beforeEach(() => {
  h.linked.mockReset();
  h.windows.mockReset();
  h.windows.mockResolvedValue([]);
  h.current = null;
});

describe("listApps and the database link (D7)", () => {
  it("attaches each app's linked database and reads dbPaused from the snapshot", async () => {
    h.current = fakeDb([[app("a1", "web-Quillpad", { dbPaused: true }), app("a2", "orbit-blog", {})]]);
    const db = { id: "d1", name: "quillpad", kind: "supabase_project", account: "utama", state: "paused" };
    h.linked.mockResolvedValue(new Map([["a1", db]]));
    const [a, b] = await listApps(NOW);
    expect(h.linked).toHaveBeenCalledWith(["a1", "a2"]);
    expect([a.database, a.dbPaused]).toEqual([db, true]);
    expect([b.database, b.dbPaused]).toEqual([null, false]);
  });
});

describe("listApps and page views", () => {
  it("reads each app's pageviews from the snapshot: null until the first read, off, or the 24 hourly slots", async () => {
    const pv = { enabled: true, total24h: 9, visitors24h: 4, readAt: "2026-10-12T04:40:00.000Z", hourly: [["2026-10-12T04:00:00.000Z", 9]] };
    h.current = fakeDb([[
      app("a1", "unread", { code: 200 }),
      app("a2", "off", { pageviews: { enabled: false, readAt: "2026-10-12T04:40:00.000Z" } }),
      app("a3", "on", { code: 200, pageviews: pv }),
    ]]);
    h.linked.mockResolvedValue(new Map());
    const [a, b, c] = await listApps(NOW);
    expect(a.pageViews).toBeNull();
    expect(b.pageViews).toEqual({ enabled: false, readAt: new Date("2026-10-12T04:40:00Z") });
    expect(c.pageViews).toMatchObject({ enabled: true, total: 9, visitors: 4 });
    if (!c.pageViews?.enabled) throw new Error("enabled");
    expect(c.pageViews.hours).toHaveLength(24);
    expect(c.pageViews.hours[23]).toEqual({ at: new Date("2026-10-12T04:00:00Z"), views: 9 });
  });
});

describe("listApps and why page views can't be read", () => {
  it("explains an app outside the pageviews task's reach, and says nothing for one it reads", async () => {
    const dep = { resourceId: "a1", id: "d1", state: "ready", target: "production" };
    h.current = fakeDb([[
      app("a1", "ok", {}),
      app("a2", "no-team", {}, { r: { id: "a2", name: "no-team", goneAt: null, meta: {} } }),
      app("a3", "account-down", {}, { accStatus: "error" }),
      app("a4", "never-deployed", {}),
    ], [], [dep]]);
    h.linked.mockResolvedValue(new Map());
    const [a, b, c, d] = await listApps(NOW);
    expect(a.pageViewsNote).toBeNull();
    expect(b.pageViewsNote).toBe("Not read: this app isn't in a connected Vercel account.");
    expect(c.pageViewsNote).toBe("Not read: this app isn't in a connected Vercel account.");
    expect(d.pageViewsNote).toBe("Not read: this app has no production deployment yet.");
  });
});

describe("listApps and maintenance windows (U5, review I1)", () => {
  const mon = (id: string, appId: string) => ({ id, resourceId: appId, url: `https://${appId}.example.com/`, state: "err", lastStatus: 502, failStreak: 3, paused: false, ownerPaused: false });
  it("reads the windows once and marks each monitor inside one with the window's end", async () => {
    h.current = fakeDb([[app("a1", "web", {}), app("a2", "api", {})], [mon("m1", "a1"), mon("m2", "a2")]]);
    h.linked.mockResolvedValue(new Map());
    h.windows.mockResolvedValue([{ id: "w", scope: "app", appId: "a1", monitorId: null, startsAt: new Date(NOW.getTime() - 60_000), durationMin: 30, weekly: false, note: null }]);
    const [a, b] = await listApps(NOW);
    expect(h.windows).toHaveBeenCalledTimes(1);
    expect(a.monitors[0].maintUntil).toEqual(new Date(NOW.getTime() + 29 * 60_000));
    expect(b.monitors[0].maintUntil).toBeNull();
  });
  it("doesn't read them for apps without monitors", async () => {
    h.current = fakeDb([[app("a1", "web", {})]]);
    h.linked.mockResolvedValue(new Map());
    await listApps(NOW);
    expect(h.windows).not.toHaveBeenCalled();
  });
});
