import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import { buildAliasBook } from "@/lib/view/display-name";
import {
  type BackupInput, buildTabs, csvCell, csvName, dueMonth, folderLabel, gzipCsv, monthLabel, monthOf, monthRange, nextBackupMonth, previousMonth, rawCsv,
  localStamp, retentionPlan, sheetTitle,
} from "./content";

const book = buildAliasBook([
  { id: "app-1", kind: "app", name: "acme-shop", firstSeenAt: "2026-10-01T00:00:00Z" },
  { id: "db-1", kind: "supabase_project", name: "secret-project", firstSeenAt: "2026-10-01T00:00:00Z" },
]);

describe("months in WIB", () => {
  it("puts the 03:00 WIB run on the 1st (20:00 UTC the day before) in the new month", () => {
    expect(monthOf(new Date("2026-10-31T20:00:00Z"))).toBe("2026-11");
    expect(monthOf(new Date("2026-10-31T16:59:59Z"))).toBe("2026-10");
    expect(monthOf(new Date("2026-10-31T17:00:00Z"))).toBe("2026-11");
  });
  it("spans the WIB month exactly", () => {
    expect(monthRange("2026-10")).toEqual({ start: new Date("2026-09-30T17:00:00Z"), end: new Date("2026-10-31T17:00:00Z") });
    expect(monthRange("2026-12").end).toEqual(new Date("2026-12-31T17:00:00Z"));
  });
  it("steps across a year and names months", () => {
    expect(previousMonth("2027-01")).toBe("2026-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(sheetTitle("2026-10")).toBe("Watchbell · 2026-10");
    expect(csvName("2026-10")).toBe("watchbell-2026-10-raw.csv.gz");
    expect(localStamp(new Date("2026-10-31T20:05:00Z"))).toBe("2026-11-01 03:05");
  });
});

describe("months in another zone (Europe/Berlin, 1.1)", () => {
  afterEach(() => resetTimeZoneForTests());

  it("bounds a month at local midnight, with summer and winter offsets", () => {
    resetTimeZoneForTests("Europe/Berlin");
    // October 2026 starts in summer time (UTC+2) and ends in winter time (UTC+1).
    expect(monthRange("2026-10")).toEqual({ start: new Date("2026-09-30T22:00:00Z"), end: new Date("2026-10-31T23:00:00Z") });
    expect(monthRange("2026-03")).toEqual({ start: new Date("2026-02-28T23:00:00Z"), end: new Date("2026-03-31T22:00:00Z") });
    expect(monthRange("2026-12").end).toEqual(new Date("2026-12-31T23:00:00Z"));
    expect(monthOf(new Date("2026-10-31T22:59:59Z"))).toBe("2026-10");
    expect(monthOf(new Date("2026-10-31T23:00:00Z"))).toBe("2026-11");
    expect(localStamp(new Date("2026-10-31T23:05:00Z"))).toBe("2026-11-01 00:05");
  });

  it("Asia/Kolkata: the month turns at 18:30 UTC", () => {
    resetTimeZoneForTests("Asia/Kolkata");
    expect(monthRange("2026-11").start).toEqual(new Date("2026-10-31T18:30:00Z"));
    expect(monthOf(new Date("2026-10-31T18:29:00Z"))).toBe("2026-10");
    expect(monthOf(new Date("2026-10-31T18:30:00Z"))).toBe("2026-11");
  });
});

describe("dueMonth (B4)", () => {
  const now = new Date("2026-10-31T20:05:00Z"); // 1 Nov 03:05 WIB
  it("is the month that just ended until it is backed up", () => {
    expect(dueMonth([], now)).toBe("2026-10");
    expect(dueMonth([{ month: "2026-10", status: "partial" }], now)).toBe("2026-10");
    expect(dueMonth([{ month: "2026-10", status: "error" }], now)).toBe("2026-10");
    expect(dueMonth([{ month: "2026-10", status: "ok" }], now)).toBeNull();
  });
  it("then retries a failed month among the last three, newest first, never an older one", () => {
    const rows = [{ month: "2026-10", status: "ok" }, { month: "2026-09", status: "error" }, { month: "2026-08", status: "error" }, { month: "2026-07", status: "error" }];
    expect(dueMonth(rows, now)).toBe("2026-09");
    expect(dueMonth([{ month: "2026-10", status: "ok" }, { month: "2026-07", status: "error" }], now)).toBeNull();
    // A month never tried (before Drive was connected) is not backed up after the fact.
    expect(dueMonth([{ month: "2026-10", status: "ok" }], now)).toBeNull();
  });
  it("says when the next one runs", () => {
    expect(nextBackupMonth([{ month: "2026-09", status: "ok" }], new Date("2026-10-15T03:00:00Z"))).toEqual({ runsOn: "1 November 2026, ~03:00 WIB", covers: "October 2026", date: "1 November 2026", at: "~03:00 WIB" });
    expect(nextBackupMonth([], new Date("2026-10-15T03:00:00Z")).covers).toBe("September 2026");
  });
  it("gives the page the date and the time apart (1.1), so nothing parses runsOn", () => {
    expect(nextBackupMonth([], new Date("2026-10-15T03:00:00Z"))).toEqual({ runsOn: "the next daily run (~03:00 WIB)", covers: "September 2026", date: null, at: "~03:00 WIB" });
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    resetTimeZoneForTests("Europe/Berlin");
    try {
      expect(nextBackupMonth([{ month: "2026-09", status: "ok" }], new Date("2026-10-15T03:00:00Z"))).toEqual({
        runsOn: "1 November 2026, ~03:00 Europe/Berlin", covers: "October 2026", date: "1 November 2026", at: "~03:00 Europe/Berlin",
      });
      const o = Object.fromEntries(buildTabs(input()).find((t) => t.title === "Overview")!.rows.filter((r) => r.length === 2).map(([k, v]) => [k, v]));
      expect(o.Covers).toBe("2026-10-01 00:00 to 2026-11-01 00:00 Europe/Berlin");
      expect(buildTabs(input()).find((t) => t.title === "Incidents")!.rows[0]).toContain("Started (Europe/Berlin)");
      vi.stubEnv("WATCHBELL_MODE", ""); // cloud: Vercel Cron at 20:00 UTC, 22:00 CEST in October
      expect(nextBackupMonth([], new Date("2026-10-15T03:00:00Z")).at).toBe("~22:00 CEST");
    } finally {
      resetTimeZoneForTests();
      vi.unstubAllEnvs();
    }
  });
});

describe("retentionPlan (B5)", () => {
  const row = (month: string, status = "ok", trashedAt: Date | null = null) => ({ month, status, trashedAt, sheetFileId: `s-${month}`, csvFileId: `c-${month}` });
  const now = new Date("2026-11-01T03:00:00Z");
  it("keeps the three newest complete months and trashes the older ones once", () => {
    const rows = [row("2026-10"), row("2026-09"), row("2026-08"), row("2026-07"), row("2026-06", "ok", new Date())];
    expect(retentionPlan(rows, now).map((r) => r.month)).toEqual(["2026-07"]);
  });
  it("does nothing until three complete months exist, and never touches the current month", () => {
    expect(retentionPlan([row("2026-10"), row("2026-09"), row("2026-11", "partial")], now)).toEqual([]);
    expect(retentionPlan([row("2026-11", "partial"), row("2026-10"), row("2026-09"), row("2026-08")], now)).toEqual([]);
  });
  it("also clears an old failed attempt's files, but not one without files", () => {
    const rows = [row("2026-10"), row("2026-09"), row("2026-08"), row("2026-05", "error"), { ...row("2026-04", "error"), sheetFileId: null, csvFileId: null }];
    expect(retentionPlan(rows, now).map((r) => r.month)).toEqual(["2026-05"]);
  });
});

const input = (over: Partial<BackupInput> = {}): BackupInput => ({
  month: "2026-10", partial: false, generatedAt: new Date("2026-10-31T20:05:00Z"), book,
  apps: [{ id: "app-1", name: "acme-shop" }, { id: "app-2", name: "owner@example.com-site" }],
  rollups: [
    { monitorId: "m1", appId: "app-1", app: "acme-shop", path: "/", hour: new Date("2026-10-02T01:00:00Z"), checks: 60, failures: 0, p50Ms: 100, p95Ms: 200, maxMs: 300, status5xx: 0, maintenance: 0 },
    { monitorId: "m1", appId: "app-1", app: "acme-shop", path: "/", hour: new Date("2026-10-02T02:00:00Z"), checks: 60, failures: 6, p50Ms: 120, p95Ms: 900, maxMs: 1200, status5xx: 2, maintenance: 0 },
    { monitorId: "m2", appId: "app-1", app: "acme-shop", path: "/api", hour: new Date("2026-10-02T02:00:00Z"), checks: 80, failures: 0, p50Ms: 90, p95Ms: 400, maxMs: 500, status5xx: 0, maintenance: 0 },
  ],
  events: [
    { at: new Date("2026-10-03T00:00:00Z"), resourceId: "db-1", resource: "secret-project", type: "database", kind: "paused", reason: "DatabasePaused", count: 2, message: "Supabase project secret-project is paused.", detail: "by owner@example.com" },
    { at: new Date("2026-10-04T00:00:00Z"), resourceId: "app-1", resource: "acme-shop", type: "deployment", kind: "ok", reason: "DeployReady", count: 1, message: "=HYPERLINK(\"x\") deployed, \"quoted\"", detail: null },
  ],
  alerts: [
    { ruleKey: "MonitorDown", severity: "critical", title: "acme-shop /", message: "3 failed checks", resourceId: "app-1", startedAt: new Date("2026-10-02T02:00:00Z"), resolvedAt: new Date("2026-10-02T02:45:00Z") },
    { ruleKey: "DatabasePaused", severity: "warning", title: "secret-project", message: "secret-project is paused", resourceId: "db-1", startedAt: new Date("2026-10-03T00:00:00Z"), resolvedAt: null },
  ],
  deployments: [
    { appId: "app-1", target: "production", state: "READY", createdAt: new Date("2026-10-04T00:00:00Z") },
    { appId: "app-1", target: "production", state: "ERROR", createdAt: new Date("2026-10-05T00:00:00Z") },
    { appId: "app-1", target: null, state: "READY", createdAt: new Date("2026-10-05T00:00:00Z") },
  ],
  databases: [{ id: "db-1", kind: "supabase_project", account: "main (owner@example.com)", state: "paused", sizeBytes: 52_428_800, cuHours: null, reads: null }],
  domains: [{ name: "life.example.org", app: "acme-shop", tlsExpires: "2026-12-01T00:00:00Z", domainExpires: null, registrar: "Example Registrar" }],
  ...over,
});

describe("buildTabs", () => {
  const tabs = buildTabs(input());
  const tab = (t: string) => tabs.find((x) => x.title === t)!.rows;
  it("has the five tabs in order", () => {
    expect(tabs.map((t) => t.title)).toEqual(["Overview", "Applications", "Incidents", "Databases", "Domains"]);
  });
  it("sums the month on Overview", () => {
    const o = Object.fromEntries(tab("Overview").filter((r) => r.length === 2).map(([k, v]) => [k, v]));
    expect(o["Watchbell backup"]).toBe("2026-10");
    expect(o.Kind).toBe("Full month");
    expect(o["Covers"]).toBe("2026-10-01 00:00 to 2026-11-01 00:00 WIB");
    expect(o["Checks (rolled-up hours)"]).toBe(200);
    expect(o["Failed checks"]).toBe(6);
    expect(o["Uptime, all monitors (%)"]).toBe(97);
    expect(o["Incidents (alerts opened)"]).toBe(2);
    expect(o["Critical incidents"]).toBe(1);
    expect(o["Production deployments"]).toBe(2);
    expect(o["Failed production deployments"]).toBe(1);
    expect(o.Events).toBe(3);
  });
  it("gives one row per app with uptime, p95, 5xx and deploys", () => {
    const a = tab("Applications");
    expect(a[1]).toEqual(["acme-shop", 2, 200, 97, 400, 900, 2, 2, 1]);
    expect(a[2]).toEqual(["[email hidden]-site", 0, 0, "", null, null, 0, 0, 0]);
  });
  it("never shows a database's real name or an email", () => {
    const all = JSON.stringify(tabs);
    expect(all).not.toContain("secret-project");
    expect(all).not.toContain("owner@example.com");
    expect(tab("Databases")[1]).toEqual(["db-a", "Supabase", "main ([email hidden])", "paused", 2, 50, null, null]);
    expect(tab("Incidents")[2]).toEqual(["DatabasePaused", "warning", "db-a", "2026-10-03 07:00", "", "29 days (still open)", "db-a is paused"]);
    expect(tab("Incidents")[1][5]).toBe("45 min");
  });
  it("counts days left at month end for domains", () => {
    expect(tab("Domains")[1]).toEqual(["life.example.org", "acme-shop", "2026-12-01T00:00:00Z", 30, "", "", "Example Registrar"]);
  });
  it("a partial backup covers the month so far", () => {
    const p = buildTabs(input({ partial: true, generatedAt: new Date("2026-10-15T03:00:00Z") }));
    const o = Object.fromEntries(p[0].rows.filter((r) => r.length === 2).map(([k, v]) => [k, v]));
    expect(o.Kind).toBe("Partial: Back up now");
    expect(o.Covers).toBe("2026-10-01 00:00 to 2026-10-15 10:00 WIB (month so far)");
  });
});

describe("raw CSV", () => {
  it("quotes per RFC 4180 and defuses formulas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-5 users")).toBe("'-5 users");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
  });
  it("holds the rollups then the events, scrubbed, and gzips losslessly", () => {
    const csv = rawCsv(input());
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("record,at,subject,resource_id,checks,failures,p50_ms,p95_ms,max_ms,status_5xx,maintenance,type,kind,reason,count,message,detail");
    expect(lines[1]).toBe("rollup,2026-10-02T01:00:00.000Z,acme-shop/,app-1,60,0,100,200,300,0,0,,,,,,");
    expect(lines[4]).toBe("event,2026-10-03T00:00:00.000Z,db-a,db-1,,,,,,,,database,paused,DatabasePaused,2,Supabase project db-a is paused.,by [email hidden]");
    expect(lines[5]).toContain(`"'=HYPERLINK(""x"") deployed, ""quoted"""`);
    expect(csv).not.toContain("secret-project");
    expect(gunzipSync(gzipCsv(csv)).toString("utf8")).toBe(csv);
  });
});

describe("folderLabel (the Backups page's folder name)", () => {
  it("is the stored folder's real name, the pre-rename name for a folder stored without one, else the new name", () => {
    expect(folderLabel({ name: "My backups" })).toBe("My backups");
    expect(folderLabel({ name: "Watchbell backups" })).toBe("Watchbell backups");
    expect(folderLabel({ name: null })).toBe("Watchpost backups"); // the owner's folder, stored before names were recorded
    expect(folderLabel(null)).toBe("Watchbell backups");
  });
});
