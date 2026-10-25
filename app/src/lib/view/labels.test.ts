import { describe, expect, it } from "vitest";
import { DOWN_AFTER } from "@/lib/collector/rules";
import type { State } from "@/lib/status";
import {
  actionsLabel, appStatus, canAct, collectorCell, credentialBanner, deploymentStatus, MONITOR_STATE_OPTIONS, monitorStatus, problemBanners, stateCounts, vercelCell,
  worstMonitor,
} from "./labels";

const now = new Date("2026-10-12T10:00:00Z"); // 17:00 WIB
const mon = (o: Partial<{ state: State; lastStatus: number | null; lastError: string | null; failStreak: number; paused: boolean; ownerPaused: boolean; maintUntil: Date | null }> = {}) => ({
  state: "ok" as State, lastStatus: 200 as number | null, failStreak: 0, paused: false, ownerPaused: false, ...o,
});

describe("canAct", () => {
  it("lets owners and operators act, never viewers", () => {
    expect(canAct("owner")).toBe(true);
    expect(canAct("operator")).toBe(true);
    expect(canAct("viewer")).toBe(false);
  });
});

describe("worstMonitor", () => {
  it("picks a down monitor over a degraded one, ignoring paused monitors", () => {
    const down = mon({ state: "err", lastStatus: 502, ownerPaused: true });
    const degraded = mon({ state: "warn", lastStatus: 500 });
    expect(worstMonitor([mon(), down, degraded])).toBe(degraded);
    expect(worstMonitor([mon()])).toBeNull();
  });
});

describe("appStatus", () => {
  it("uses the mockup's labels with the real cause", () => {
    expect(appStatus({ state: "ok", gone: false, monitors: [mon()] })).toEqual({ state: "ok", label: "Running" });
    expect(appStatus({ state: "build", gone: false, monitors: [mon()] })).toEqual({ state: "build", label: "Building" });
    expect(appStatus({ state: "warn", gone: false, monitors: [mon({ state: "warn", lastStatus: 500 })] })).toEqual({ state: "warn", label: "Degraded · HTTP 500" });
    expect(appStatus({ state: "err", gone: false, monitors: [mon({ state: "err", lastStatus: null })] })).toEqual({ state: "err", label: "Down · no answer" });
  });
  it("says why there is no state yet", () => {
    expect(appStatus({ state: "unknown", gone: false, monitors: [] })).toEqual({ state: "unknown", label: "No active monitors" });
    expect(appStatus({ state: "unknown", gone: false, monitors: [mon({ state: "unknown" })] })).toEqual({ state: "unknown", label: "Not checked yet" });
  });
  it("marks an app Vercel no longer lists", () => {
    expect(appStatus({ state: "ok", gone: true, monitors: [mon()] })).toEqual({ state: "off", label: "Gone from Vercel" });
  });
});

describe("deploymentStatus", () => {
  it("maps Vercel states to the mockup's labels", () => {
    expect(deploymentStatus("ready")).toEqual({ state: "ok", label: "Ready" });
    expect(deploymentStatus("building")).toEqual({ state: "build", label: "Building" });
    expect(deploymentStatus("error")).toEqual({ state: "fail", label: "Error" });
    expect(deploymentStatus("canceled")).toEqual({ state: "off", label: "Canceled" });
  });
});

describe("monitorStatus", () => {
  it("uses Up, Degraded · code and Down · code", () => {
    expect(monitorStatus(mon())).toEqual({ state: "ok", label: "Up" });
    expect(monitorStatus(mon({ state: "warn", lastStatus: 500 }))).toEqual({ state: "warn", label: "Degraded · 500" });
    expect(monitorStatus(mon({ state: "err", lastStatus: null }))).toEqual({ state: "err", label: "Down · no answer" });
    expect(monitorStatus(mon({ state: "err", lastStatus: 502, lastError: "HTTP 502" }))).toEqual({ state: "err", label: "Down · 502" });
  });
  it("names a missed keyword or JSON value instead of the 200 it answered", () => {
    expect(monitorStatus(mon({ state: "err", lastStatus: 200, lastError: "Keyword not found" }))).toEqual({ state: "err", label: "Down · Keyword not found" });
    expect(monitorStatus(mon({ state: "warn", lastStatus: 200, lastError: 'JSON status is "down", expected "ok"' }))).toEqual({ state: "warn", label: 'Degraded · JSON status is "down", expected "ok"' });
    expect(appStatus({ state: "err", gone: false, monitors: [mon({ state: "err", lastStatus: 200, lastError: "Keyword not found" })] })).toEqual({ state: "err", label: "Down · Keyword not found" });
    expect(appStatus({ state: "warn", gone: false, monitors: [mon({ state: "warn", lastStatus: 200, lastError: "Keyword not found" })] })).toEqual({ state: "warn", label: "Degraded · Keyword not found" });
    expect(monitorStatus(mon({ state: "unknown" }))).toEqual({ state: "unknown", label: "Waiting for first check" });
  });
  it("shows the owner's pause before Sync's", () => {
    expect(monitorStatus(mon({ ownerPaused: true, paused: true }))).toEqual({ state: "paused", label: "Paused" });
    expect(monitorStatus(mon({ paused: true }))).toEqual({ state: "off", label: "App not watched" });
  });
});

describe("monitorStatus of a moved domain (1.2.1)", () => {
  it("reads Domain changed (a warning) instead of Down; paused and maintenance still win", () => {
    const move = { from: "old.example.com", to: "new.example.com" };
    expect(monitorStatus({ ...mon({ state: "err", lastStatus: null }), move })).toEqual({ state: "warn", label: "Domain changed: old.example.com → new.example.com" });
    expect(monitorStatus({ ...mon({ state: "ok" }), move })).toMatchObject({ state: "warn" });
    expect(monitorStatus({ ...mon({ ownerPaused: true }), move })).toEqual({ state: "paused", label: "Paused" });
  });
});

describe("monitorStatus of a heartbeat (U3)", () => {
  const hb = (o: Record<string, unknown> = {}) => ({ ...mon({ lastStatus: null }), kind: "heartbeat", lastError: null, lastPingAt: new Date(now.getTime() - 12 * 60_000), ...o });
  it("reads from the last ping and the stored reason, as in the mockup", () => {
    expect(monitorStatus(hb(), null, now)).toEqual({ state: "ok", label: "Up · pinged 12 min ago" });
    expect(monitorStatus(hb({ state: "warn", lastError: "Late · last ping 1 h ago" }), null, now)).toEqual({ state: "warn", label: "Late" });
    expect(monitorStatus(hb({ state: "err", lastError: "Down · the job reported a failure" }), null, now)).toEqual({ state: "err", label: "Down · the job reported a failure" });
    expect(monitorStatus(hb({ state: "err", lastError: null }), null, now)).toEqual({ state: "err", label: "Down · no ping" });
    expect(monitorStatus(hb({ state: "unknown", lastPingAt: null }), null, now)).toEqual({ state: "unknown", label: "Waiting for the first ping" });
  });
  it("still shows a pause first", () => {
    expect(monitorStatus(hb({ ownerPaused: true }), null, now)).toEqual({ state: "paused", label: "Paused" });
  });
  it("names the job when it is what makes the app down or degraded", () => {
    const m = (state: State) => ({ ...mon({ state, lastStatus: null }), kind: "heartbeat" as const, name: "backup job" });
    // A job never makes the app Down: the website may be fine.
    expect(appStatus({ state: "err", gone: false, monitors: [m("err")] })).toEqual({ state: "warn", label: "Degraded · job backup job not pinging" });
    expect(appStatus({ state: "warn", gone: false, monitors: [m("warn")] })).toEqual({ state: "warn", label: "Degraded · job backup job late" });
    // The website down as well: Down, named by the website's check.
    expect(appStatus({ state: "err", gone: false, monitors: [m("err"), mon({ state: "err", lastStatus: 502 })] })).toEqual({ state: "err", label: "Down · HTTP 502" });
    // Only a job down while the site answers: Degraded.
    expect(appStatus({ state: "err", gone: false, monitors: [m("err"), mon()] })).toEqual({ state: "warn", label: "Degraded · job backup job not pinging" });
    const since = new Date(now.getTime() - 3 * 3600_000);
    const [down] = problemBanners([{ id: "a1", name: "web", state: "err", gone: false, since, monitors: [m("err")], lastDeploy: null }], now);
    expect(down).toMatchObject({ tone: "warning", title: "web: background job backup job is down", action: { href: "/uptime" } });
    expect(down.body).toMatch(/^The website is up; the job hasn't pinged for /);
    const [late] = problemBanners([{ id: "a1", name: "web", state: "warn", gone: false, since, monitors: [m("warn")], lastDeploy: null }], now);
    expect(late).toMatchObject({ tone: "warning", body: "The job backup job is late. It's marked down once its grace time passes too." });
  });
});

describe("monitorStatus inside a maintenance window (U5)", () => {
  const active = { end: new Date("2026-10-12T19:00:00Z") }; // 02:00 WIB
  it("reads Maintenance · until HH:MM (WIB), whatever the last check said", () => {
    expect(monitorStatus(mon({ state: "err", lastStatus: 502 }), active)).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    expect(monitorStatus(mon(), active)).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    expect(monitorStatus(mon({ state: "err", lastStatus: 502 }), null)).toEqual({ state: "err", label: "Down · 502" });
  });
  it("lets a pause or a gone app win, since nothing is checked then", () => {
    expect(monitorStatus(mon({ ownerPaused: true }), active)).toEqual({ state: "paused", label: "Paused" });
    expect(monitorStatus(mon({ paused: true }), active)).toEqual({ state: "off", label: "App not watched" });
    expect(monitorStatus({ ...mon(), appGone: true }, active)).toEqual({ state: "off", label: "App removed from Vercel" });
  });
  it("is a filter option and a state word", () => {
    expect(MONITOR_STATE_OPTIONS).toContainEqual(["maint", "Maintenance"]);
  });
});

describe("apps and monitors inside a maintenance window elsewhere (U5, review I1)", () => {
  const until = new Date("2026-10-12T19:00:00Z"); // 02:00 WIB
  const inside = (o: Parameters<typeof mon>[0] = {}) => mon({ state: "err", lastStatus: 502, failStreak: 3, maintUntil: until, ...o });
  it("monitorStatus reads the monitor's own window when none is passed", () => {
    expect(monitorStatus(inside())).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    expect(monitorStatus(inside(), null)).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
  });
  it("worstMonitor leaves monitors inside a window out", () => {
    const degraded = mon({ state: "warn", lastStatus: 500 });
    expect(worstMonitor([inside()])).toBeNull();
    expect(worstMonitor([inside(), degraded])).toBe(degraded);
  });
  it("an app whose only failing monitor is in maintenance isn't red: it reads Maintenance until the window ends", () => {
    expect(appStatus({ state: "err", gone: false, monitors: [inside(), mon()] })).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    expect(appStatus({ state: "warn", gone: false, monitors: [inside({ state: "warn" })] })).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
  });
  it("another failing monitor, a paused database or a build still show", () => {
    expect(appStatus({ state: "err", gone: false, monitors: [inside(), mon({ state: "warn", lastStatus: 500 })] })).toEqual({ state: "warn", label: "Degraded · HTTP 500" });
    expect(appStatus({ state: "err", gone: false, monitors: [inside(), mon({ state: "err", lastStatus: 503 })] })).toEqual({ state: "err", label: "Down · HTTP 503" });
    expect(appStatus({ state: "warn", gone: false, dbPaused: true, monitors: [inside({ state: "warn" })] })).toEqual({ state: "warn", label: "Degraded · DB paused" });
    expect(appStatus({ state: "err", gone: false, building: true, monitors: [inside()] })).toEqual({ state: "build", label: "Building" });
  });
  it("an app with every checked monitor in maintenance reads Maintenance, using the window that ends last", () => {
    const later = new Date("2026-10-12T20:30:00Z"); // 03:30 WIB
    expect(appStatus({ state: "ok", gone: false, monitors: [inside({ state: "ok" }), inside({ state: "ok", maintUntil: later })] })).toEqual({ state: "maint", label: "Maintenance · until 03:30" });
    expect(appStatus({ state: "ok", gone: false, monitors: [inside({ state: "ok" }), mon()] })).toEqual({ state: "ok", label: "Running" });
    expect(appStatus({ state: "ok", gone: true, monitors: [inside()] })).toEqual({ state: "off", label: "Gone from Vercel" });
  });
  it("problemBanners raises nothing for an app down only inside a window", () => {
    const app = { id: "a1", name: "web", state: "err" as State, gone: false, since: now, lastDeploy: null };
    expect(problemBanners([{ ...app, monitors: [inside()] }], now)).toEqual([]);
    expect(problemBanners([{ ...app, monitors: [inside(), mon({ state: "err", lastStatus: 503 })] }], now)).toHaveLength(1);
  });
  it("Inventory counts maintenance", () => {
    expect(stateCounts(["ok", "maint"])).toEqual([{ state: "ok", n: 1 }, { state: "maint", n: 1 }]);
  });
});

describe("a heartbeat inside a maintenance window (U3 + U5, B3)", () => {
  const until = new Date("2026-10-12T19:00:00Z"); // 02:00 WIB
  const hb = (o: Record<string, unknown> = {}) => ({
    ...mon({ lastStatus: null }), kind: "heartbeat" as const, name: "backup job", lastError: null as string | null, lastPingAt: new Date(now.getTime() - 3 * 3600_000), ...o,
  });
  it("reads Maintenance · until HH:MM instead of Up, Late, Down or Waiting, from the window passed or its own maintUntil", () => {
    for (const state of ["ok", "warn", "err", "unknown"] as State[]) {
      expect(monitorStatus(hb({ state, lastError: "Down · no ping for 3 h" }), { end: until }, now)).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
      expect(monitorStatus(hb({ state, maintUntil: until }), null, now)).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    }
  });
  it("still lets a pause or a gone app win, and reads its own state again once the window is over", () => {
    expect(monitorStatus(hb({ ownerPaused: true }), { end: until }, now)).toEqual({ state: "paused", label: "Paused" });
    expect(monitorStatus(hb({ paused: true }), { end: until }, now)).toEqual({ state: "off", label: "App not watched" });
    expect(monitorStatus({ ...hb(), appGone: true }, { end: until }, now)).toEqual({ state: "off", label: "App removed from Vercel" });
    expect(monitorStatus(hb({ state: "err", lastError: "Down · no ping for 3 h" }), null, now)).toEqual({ state: "err", label: "Down · no ping for 3 h" });
  });
  it("worstMonitor, appStatus and problemBanners skip a heartbeat inside a window", () => {
    const late = hb({ state: "err", maintUntil: until });
    expect(worstMonitor([late])).toBeNull();
    expect(appStatus({ state: "err", gone: false, monitors: [late, mon()] })).toEqual({ state: "maint", label: "Maintenance · until 02:00" });
    expect(problemBanners([{ id: "a1", name: "web", state: "err", gone: false, since: now, monitors: [late], lastDeploy: null }], now)).toEqual([]);
    // Outside the window the job is named again.
    expect(appStatus({ state: "err", gone: false, monitors: [hb({ state: "err" }), mon()] })).toEqual({ state: "warn", label: "Degraded · job backup job not pinging" });
  });
});

describe("monitorStatus of a gone app (M5)", () => {
  it("reads App removed from Vercel, not App not watched, whatever the pause flags say", () => {
    expect(monitorStatus({ ...mon({ paused: true }), appGone: true })).toEqual({ state: "off", label: "App removed from Vercel" });
    expect(monitorStatus({ ...mon({ ownerPaused: true, paused: true }), appGone: true })).toEqual({ state: "off", label: "App removed from Vercel" });
    expect(monitorStatus({ ...mon({ paused: true }), appGone: false })).toEqual({ state: "off", label: "App not watched" });
  });
});

describe("actionsLabel (the kebab's accessible name)", () => {
  it("names the row, skipping empty parts", () => {
    expect(actionsLabel("shortly")).toBe("Actions for shortly");
    expect(actionsLabel("shortly", "abc1234")).toBe("Actions for shortly abc1234");
    expect(actionsLabel("shortly", null)).toBe("Actions for shortly");
    expect(actionsLabel("shortly", "/health")).toBe("Actions for shortly /health");
    expect(actionsLabel("shortly", "")).toBe("Actions for shortly");
  });
});

describe("status strip", () => {
  it("summarises the Vercel apps, worst state first", () => {
    expect(vercelCell(["err", "build", "ok", "ok", "warn", "ok"])).toEqual({ state: "err", sub: "6 apps · 1 down, 1 degraded, 1 building" });
    expect(vercelCell(["ok"])).toEqual({ state: "ok", sub: "1 app" });
  });
  it("says so when nothing is watched yet (fresh install)", () => {
    expect(vercelCell([])).toEqual({ state: "unknown", sub: "No apps watched yet" });
  });
  it("describes the last collector run, and turns red when it stops", () => {
    expect(collectorCell({ finishedAt: new Date(now.getTime() - 12_000), durationMs: 1900, checks: 18 }, now)).toEqual({ state: "ok", sub: "12s ago · 1.9 s · 18 checks" });
    expect(collectorCell({ finishedAt: new Date(now.getTime() - 6 * 60_000), durationMs: null, checks: 1 }, now)).toEqual({ state: "err", sub: "6 min ago · — · 1 check" });
    expect(collectorCell(null, now)).toEqual({ state: "unknown", sub: "Hasn't run yet" });
  });
});

describe("stateCounts", () => {
  it("counts states in the mockup's order and drops zeros", () => {
    expect(stateCounts(["ok", "err", "ok", "build"])).toEqual([{ state: "ok", n: 2 }, { state: "build", n: 1 }, { state: "err", n: 1 }]);
    expect(stateCounts([])).toEqual([]);
  });
});

describe("problemBanners", () => {
  const app = (o: Partial<Parameters<typeof problemBanners>[0][number]> = {}) => ({
    id: "a1", name: "orbit-blog", state: "err" as State, gone: false, since: new Date(now.getTime() - 4 * 60_000),
    monitors: [mon({ state: "err", lastStatus: 502, failStreak: 4 })],
    lastDeploy: { state: "error", createdAt: new Date("2026-10-12T05:40:00Z"), readyAt: new Date("2026-10-12T05:41:00Z") } as { state: string; createdAt: Date; readyAt: Date | null } | null,
    ...o,
  });
  it("raises a danger banner for a down app, naming the failed deploy", () => {
    expect(problemBanners([app()], now)).toEqual([{
      key: "a1", tone: "danger", title: "orbit-blog is down",
      body: "HTTP 502 for 4 minutes. The last production deploy failed at 12:41.",
      action: { label: "View deployment", href: "/deployments" },
    }]);
  });
  it("links to the app when there is no failed deploy, or no deployment at all", () => {
    expect(problemBanners([app({ lastDeploy: null })], now)[0]).toMatchObject({ body: "HTTP 502 for 4 minutes.", action: { label: "Open app", href: "/apps/a1" } });
  });
  it("leaves out the duration when it is not known when the app went down", () => {
    expect(problemBanners([app({ since: null })], now)[0]).toMatchObject({
      body: "HTTP 502. The last production deploy failed at 12:41.",
    });
    expect(problemBanners([app({ since: null, lastDeploy: null })], now)[0]).toMatchObject({ body: "HTTP 502." });
  });
  it("raises a warning for a degraded app, after the danger ones", () => {
    const degraded = app({ id: "a2", name: "web-Quillpad", state: "warn", monitors: [mon({ state: "warn", lastStatus: 500, failStreak: 1 })] });
    const banners = problemBanners([degraded, app()], now);
    expect(banners.map((b) => b.tone)).toEqual(["danger", "warning"]);
    expect(banners[1]).toMatchObject({ title: "web-Quillpad is degraded", body: `HTTP 500 on 1 check in a row. It's marked down after ${DOWN_AFTER}.` });
  });
  it("stays quiet for healthy and gone apps", () => {
    expect(problemBanners([app({ state: "ok" }), app({ gone: true })], now)).toEqual([]);
  });
});

describe("credentialBanner", () => {
  it("never shows an email account label (privacy)", () => {
    expect(credentialBanner([{ provider: "supabase", label: "me@gmail.com" }], "owner")?.body).toBe("supabase · [email hidden]. Data from this account is not being updated.");
  });
  it("names the broken accounts, and only the provider for a viewer", () => {
    expect(credentialBanner([], "owner")).toBeNull();
    expect(credentialBanner([{ provider: "supabase", label: "kedua" }], "owner")).toEqual({
      title: "1 connection needs attention", body: "supabase · kedua. Data from this account is not being updated.",
    });
    expect(credentialBanner([{ provider: "supabase", label: "kedua" }, { provider: "supabase", label: "utama" }], "viewer")).toEqual({
      title: "2 connections need attention", body: "supabase. Data from these accounts is not being updated.",
    });
  });
});

describe("appStatus and problemBanners with a paused database (D7)", () => {
  it("names the database as the cause when no monitor is degraded", () => {
    expect(appStatus({ state: "warn", gone: false, monitors: [mon()], dbPaused: true })).toEqual({ state: "warn", label: "Degraded · DB paused" });
    expect(appStatus({ state: "warn", gone: false, monitors: [mon({ state: "warn", lastStatus: 500 })], dbPaused: true })).toEqual({ state: "warn", label: "Degraded · HTTP 500" });
  });
  it("leaves a database-only cause to the database banner", () => {
    const now = new Date("2026-10-12T05:00:00Z");
    expect(problemBanners([{ id: "a", name: "web-Quillpad", state: "warn", gone: false, since: now, monitors: [mon()], lastDeploy: null, dbPaused: true }], now)).toEqual([]);
  });
});
