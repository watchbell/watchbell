import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DayCount } from "@/lib/view/uptime";
import { type Call, fakeDb, limitOf, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, monitorDays: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./metrics-db", () => ({ monitorDays: h.monitorDays }));

import { publicBadge, publicMonitorIds, publicView, saveStatusPage, statusPageSettings } from "./public-status-db";

const PAGE = "11111111-2222-4333-8444-555555555555";
const M1 = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const M2 = "7a1e5d2f-8d66-4b1c-8e3f-2b3c4d5e6f70";
const APP = "8b2f6e3a-9e77-4c2d-9f4a-3c4d5e6f7081";
const now = new Date("2026-10-13T03:00:00Z"); // 13 Oct 10:00 WIB

const page = (o: Record<string, unknown> = {}) => ({ id: PAGE, title: "Acme' apps", announcement: null, published: true, ...o });
// What a careless query could drag along: the B1 test proves none of it reaches the output.
const leaky = { url: "https://secret.example.com/admin", lastError: "HTTP 500 at /admin", appName: "vercel-portfolio-supabase", lastStatus: 500 };
const row = (o: Record<string, unknown> = {}) => ({
  displayName: "Portfolio", badgeKey: "portfolio", position: 0, id: M1, appId: APP, state: "ok", paused: false, ownerPaused: false, kind: "http", watched: true,
  ...leaky, ...o,
});
const win = (o: Record<string, unknown> = {}) => ({
  id: "99999999-2222-4333-8444-555555555555", scope: "all", resourceId: null, monitorId: null, startsAt: new Date("2026-10-13T15:00:00Z"), durationMin: 90,
  weekly: false, note: "Some services may be slow.", createdBy: null, createdAt: now, updatedAt: now, ...o,
});
const day = (checks: number, failures: number): DayCount => ({ day: "2026-10-13", checks, failures, maint: 0 });

const use = (reads: unknown[][], writes: unknown[][] = []) => {
  const f = fakeDb(reads, writes);
  h.current = f;
  return f;
};
const selectKeys = (q: Call[]) => Object.keys((q.find((c) => c.method === "select")?.args[0] ?? {}) as object).sort();

beforeEach(() => {
  h.current = null;
  h.monitorDays.mockReset();
  h.monitorDays.mockResolvedValue(new Map([[M1, new Map([["2026-10-13", day(1440, 0)]])]]));
});

describe("publicView (B1)", () => {
  it("shows names, state words, uptime, bars and maintenance, and nothing private", async () => {
    use([[page()], [row(), row({ displayName: "Wedding site", badgeKey: "wedding-site", position: 1, id: M2, state: "err" })], [win()]]);
    const v = await publicView("acme", now);
    expect(v).toMatchObject({
      title: "Acme' apps", announcement: null,
      maintenance: [{ note: "Some services may be slow.", from: "13 Oct 22:00", to: "23:30", active: false }],
      monitors: [
        { name: "Portfolio", badge: "portfolio", state: "ok", label: "Operational", uptime: "100.00%" },
        { name: "Wedding site", badge: "wedding-site", state: "err", label: "Down", uptime: "—" },
      ],
    });
    expect(v!.monitors[0].bars).toHaveLength(90);
    expect(v!.monitors[0].bars.at(-1)).toEqual({ tone: "ok", title: "Today · 0 failed of 1440" });
    expect(Object.keys(v!).sort()).toEqual(["announcement", "maintenance", "monitors", "title"]);
    expect(Object.keys(v!.monitors[0]).sort()).toEqual(["badge", "bars", "label", "name", "state", "uptime"]);
    const json = JSON.stringify(v);
    expect(json).not.toContain("secret.example.com");
    expect(json).not.toContain("/admin");
    expect(json).not.toContain("HTTP 500");
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(json).not.toMatch(/vercel|supabase|neon|cloudflare|firebase/i);
    expect(h.monitorDays).toHaveBeenCalledWith([M1, M2], now);
  });

  it("selects only the B1 columns, by slug, at most 30 monitors", async () => {
    const f = use([[page()], [row()], []]);
    await publicView("acme", now);
    expect(selectKeys(f.queries[0])).toEqual(["announcement", "id", "published", "title"]);
    expect(limitOf(f.queries[0])).toBe(1);
    expect(selectKeys(f.queries[1])).toEqual(["appId", "badgeKey", "displayName", "id", "kind", "ownerPaused", "paused", "position", "state", "watched"]);
    expect(limitOf(f.queries[1])).toBe(30);
  });

  it("is null for an unpublished or unknown page, without reading monitors", async () => {
    const f = use([[page({ published: false })]]);
    expect(await publicView("acme", now)).toBeNull();
    expect(f.queries).toHaveLength(1);
    use([[]]);
    expect(await publicView("nope", now)).toBeNull();
    expect(h.monitorDays).not.toHaveBeenCalled();
  });

  it("reads Maintenance for a monitor inside a window, and Maintenance now in the banner", async () => {
    use([[page()], [row()], [win({ startsAt: new Date("2026-10-13T02:30:00Z") })]]);
    const v = await publicView("acme", now);
    expect(v!.monitors[0]).toMatchObject({ state: "maint", label: "Maintenance" });
    expect(v!.maintenance).toEqual([{ note: "Some services may be slow.", from: "13 Oct 09:30", to: "11:00", active: true }]);
  });

  it("leaves out windows for apps not on the page and windows more than 7 days ahead", async () => {
    use([[page()], [row()], [
      win({ scope: "app", resourceId: "00000000-0000-4000-8000-000000000000" }),
      win({ scope: "monitor", monitorId: M2 }),
      win({ startsAt: new Date("2026-10-21T15:00:00Z") }),
      win({ scope: "app", resourceId: APP, note: null }),
    ]]);
    expect((await publicView("acme", now))!.maintenance).toEqual([{ note: null, from: "13 Oct 22:00", to: "23:30", active: false }]);
  });

  it("shows paused, unwatched and gone monitors as No data, and a late heartbeat as Degraded, never Down", async () => {
    use([[page()], [
      row({ ownerPaused: true, state: "err" }),
      row({ id: M2, badgeKey: "b", paused: true }),
      row({ badgeKey: "c", watched: false, state: "err" }),
      row({ badgeKey: "d", kind: "heartbeat", state: "err" }),
    ], []]);
    expect((await publicView("acme", now))!.monitors.map((m) => m.label)).toEqual(["No data", "No data", "No data", "Degraded"]);
  });
});

describe("publicBadge", () => {
  it("gives the monitor's 90-day uptime, or its state word without data", async () => {
    use([[page()], [row(), row({ id: M2, badgeKey: "wedding-site", state: "err" })], []]);
    expect(await publicBadge("acme", "portfolio", now)).toEqual({ label: "uptime", value: "100.00%", tone: "ok" });
    use([[page()], [row(), row({ id: M2, badgeKey: "wedding-site", state: "err" })], []]);
    expect(await publicBadge("acme", "wedding-site", now)).toEqual({ label: "uptime", value: "down", tone: "err" });
  });
  it("is null for an unknown key or an unpublished page", async () => {
    use([[page()], [row()], []]);
    expect(await publicBadge("acme", "nope", now)).toBeNull();
    use([[page({ published: false })]]);
    expect(await publicBadge("acme", "portfolio", now)).toBeNull();
  });
});

describe("statusPageSettings", () => {
  it("lists every monitor of a watched app with what the page shows for it", async () => {
    use([
      [{ id: PAGE, slug: "acme", title: "T", announcement: "A", published: true }],
      [{ id: M1, appName: "web", url: "https://web.example.com/", kind: "http", name: null }, { id: M2, appName: "web", url: "heartbeat:backup", kind: "heartbeat", name: "backup" }],
      [{ monitorId: M2, displayName: "Backups", position: 0 }],
    ]);
    expect(await statusPageSettings()).toEqual({
      page: { slug: "acme", title: "T", announcement: "A", published: true },
      monitors: [
        { id: M2, appName: "web", path: "backup", kind: "heartbeat", shown: true, displayName: "Backups" },
        { id: M1, appName: "web", path: "/", kind: "http", shown: false, displayName: "" },
      ],
    });
  });
  it("has no page before the first save", async () => {
    use([[], []]);
    expect(await statusPageSettings()).toEqual({ page: null, monitors: [] });
  });
});

describe("publicMonitorIds", () => {
  it("gives the monitors on a published page, for the Uptime page's Public tag", async () => {
    const f = use([[{ monitorId: M1 }, { monitorId: M2 }]]);
    expect(await publicMonitorIds()).toEqual(new Set([M1, M2]));
    expect(limitOf(f.queries[0])).toBe(30);
    expect(f.queries[0].map((c) => c.method)).toEqual(expect.arrayContaining(["innerJoin", "where"]));
  });
});

describe("saveStatusPage", () => {
  const value = { slug: "acme", title: "T", announcement: null, published: true, monitors: [{ monitorId: M1, displayName: "Wedding site", position: 0 }] };

  it("creates the one page and its monitors with badge keys", async () => {
    const f = use([[], [{ id: M1 }]], [[{ id: PAGE }]]);
    expect(await saveStatusPage(value)).toEqual({ ok: true, oldSlug: null, message: "Status page saved. It updates within a minute.", audit: { message: "Status page saved: /s/acme (published, 1 monitor)", resourceId: null } });
    expect(f.writes.map((w) => w.kind)).toEqual(["insert", "delete", "insert"]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ slug: "acme", title: "T", announcement: null, published: true });
    expect(payloadOf(f.writes[2].calls)).toEqual([{ pageId: PAGE, monitorId: M1, displayName: "Wedding site", badgeKey: "wedding-site", position: 0 }]);
  });

  it("updates the existing page and remembers its old address", async () => {
    const f = use([[{ id: PAGE, slug: "old-name" }], [{ id: M1 }]]);
    expect(await saveStatusPage({ ...value, published: false })).toMatchObject({ ok: true, oldSlug: "old-name", audit: { message: "Status page saved: /s/acme (not published, 1 monitor)" } });
    expect(f.writes.map((w) => w.kind)).toEqual(["update", "delete", "insert"]);
  });

  it("refuses a monitor that no longer exists, before writing", async () => {
    const f = use([[], []]);
    expect(await saveStatusPage(value)).toEqual({ ok: false, error: "A monitor on the list no longer exists. Reload and try again." });
    expect(f.writes).toHaveLength(0);
  });

  it("writes no monitor rows for an empty list", async () => {
    const f = use([[{ id: PAGE, slug: "acme" }]]);
    expect(await saveStatusPage({ ...value, monitors: [] })).toMatchObject({ ok: true });
    expect(f.writes.map((w) => w.kind)).toEqual(["update", "delete"]);
  });
});
