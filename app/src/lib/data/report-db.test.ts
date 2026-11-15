import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { deployDays, reports, reportSends, reportSites } from "@/db/report-schema";
import * as schema from "@/db/schema";
import { accounts, alertRules, alerts, monitors, resources, rollupsHourly } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/data/settings-db", () => ({ readRetentionDays: async () => ({ checks: 7, rollupsHourly: 90, deployments: 30, events: 90, alerts: 90, collectorRuns: 14, storedLogs: 7, recommendationDismissals: 90 }) }));

import { createReport, deleteReport, finishedMonths, offeredKeepDays, getReport, listReports, readReportInput, reportMonitorOptions, reportSendFacts, updateReportContent, updateReportDelivery } from "./report-db";

const Z = "Asia/Jakarta";
const NOW = new Date("2026-11-13T05:00:00Z");
let client: PGlite;
const ids = { report: "", empty: "", m1: "", m2: "", app: "" };

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  const [acc] = await db.insert(accounts).values({ provider: "vercel", label: "me", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_1", name: "kopi-web" }).returning();
  ids.app = app.id;
  const [m1] = await db.insert(monitors).values({ resourceId: app.id, url: "https://kopisejahtera.id/" }).returning();
  const [m2] = await db.insert(monitors).values({ resourceId: app.id, url: "https://shop.kopisejahtera.id/", intervalS: 300 }).returning();
  ids.m1 = m1.id;
  ids.m2 = m2.id;
  // October in WIB: m1 every hour of the month (one failed hour on the 23rd, 02:00 WIB), m2 only from 15 Oct.
  const rows: (typeof rollupsHourly.$inferInsert)[] = [];
  for (let t = Date.parse("2026-09-30T17:00:00Z"); t < Date.parse("2026-10-31T17:00:00Z"); t += 3_600_000) {
    const hour = new Date(t);
    rows.push({ monitorId: m1.id, hour, checks: 60, failures: hour.toISOString() === "2026-10-22T19:00:00.000Z" ? 22 : 0, p50Ms: 280 });
    if (t >= Date.parse("2026-10-14T17:00:00Z")) rows.push({ monitorId: m2.id, hour, checks: 12, failures: 0, p50Ms: 400 });
  }
  await db.insert(rollupsHourly).values(rows);
  await db.insert(alertRules).values([{ key: "MonitorDown", severity: "critical" }, { key: "HighLatency", severity: "warning" }]).onConflictDoNothing();
  await db.insert(alerts).values([
    { ruleKey: "MonitorDown", subject: m1.id, resourceId: app.id, severity: "critical", title: "down", message: "https://kopisejahtera.id/ 502", startedAt: new Date("2026-10-22T19:14:00Z"), lastSeenAt: new Date("2026-10-22T19:36:00Z"), resolvedAt: new Date("2026-10-22T19:36:00Z") },
    { ruleKey: "MonitorDown", subject: m1.id, resourceId: app.id, severity: "critical", title: "down", message: "x", startedAt: new Date("2026-09-10T00:00:00Z"), lastSeenAt: new Date("2026-09-10T00:10:00Z"), resolvedAt: new Date("2026-09-10T00:10:00Z") },
  ]);
  await db.insert(deployDays).values([{ resourceId: app.id, day: "2026-10-02", ok: 4, failed: 0 }, { resourceId: app.id, day: "2026-10-23", ok: 1, failed: 1 }, { resourceId: app.id, day: "2026-11-02", ok: 3, failed: 0 }]);
  const [r] = await db.insert(reports).values({ clientName: "PT Kopi Sejahtera", lang: "id", recipients: ["owner@kopi.example"] }).returning();
  ids.report = r.id;
  await db.insert(reportSites).values([{ reportId: r.id, monitorId: m1.id, displayName: "Toko utama", position: 0 }, { reportId: r.id, monitorId: m2.id, displayName: "Toko online", position: 1 }]);
  const [e] = await db.insert(reports).values({ clientName: "Nobody" }).returning();
  ids.empty = e.id;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("finishedMonths (1.7)", () => {
  it("offers finished months whose first day is still inside the rollup retention, newest first", () => {
    expect(finishedMonths(NOW, Z, 90)).toEqual(["2026-10", "2026-09"]);
    expect(finishedMonths(NOW, Z, 7)).toEqual([]);
    // Compared by install-zone day: 92 days before 1 Nov 07:30 WIB is 1 Aug, so August is still offered.
    expect(finishedMonths(new Date("2026-11-01T00:30:00Z"), Z, 92)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });
});

// Review I-1/I-2: a month is offered only while every section of it is still kept: day counts are read for 90 days
// (the Uptime bars), and alerts may be kept for less than the rollups.
describe("offeredKeepDays", () => {
  it("is the shortest of the rollups, the alerts and the 90 days the day counts cover", () => {
    const r = { checks: 7, rollupsHourly: 180, deployments: 30, events: 90, alerts: 90, collectorRuns: 14, storedLogs: 7, recommendationDismissals: 90 };
    expect(offeredKeepDays(r)).toBe(90);
    expect(offeredKeepDays({ ...r, rollupsHourly: 90, alerts: 30 })).toBe(30);
    expect(offeredKeepDays({ ...r, rollupsHourly: 60 })).toBe(60);
  });
});

describe("readReportInput (1.7)", () => {
  it("reads the month in the install's zone: days, response, incidents, deploys", async () => {
    const r = await readReportInput(ids.report, "2026-10", NOW, Z);
    if ("error" in r) throw new Error(r.error);
    const [s1, s2] = r.sites;
    expect(s1).toMatchObject({ name: "Toko utama", intervalS: 60, firstDay: "2026-10-01" });
    expect(s1.days.get("2026-10-23")).toMatchObject({ checks: 1440, failures: 22 });
    expect(s1.days.get("2026-10-01")?.checks).toBe(1440);
    expect(s1.p50ByDay.get("2026-10-05")).toBe(280);
    expect(s2).toMatchObject({ name: "Toko online", intervalS: 300, firstDay: "2026-10-15" });
    expect(r.incidents).toEqual([{ monitorId: ids.m1, kind: "down", startedAt: new Date("2026-10-22T19:14:00Z"), resolvedAt: new Date("2026-10-22T19:36:00Z"), endedBy: "resolved" }]);
    expect(r.deploys.find((d) => d.monitorId === ids.m1)).toMatchObject({ ok: 5, failed: 1 });
    expect(r.zone).toBe(Z);
  });

  it("refuses a report without sites, an old month and an unknown report", async () => {
    expect(await readReportInput(ids.empty, "2026-10", NOW, Z)).toEqual({ error: "no-sites" });
    expect(await readReportInput(ids.report, "2026-06", NOW, Z)).toEqual({ error: "month-too-old" });
    expect(await readReportInput("00000000-0000-4000-8000-000000000000", "2026-10", NOW, Z)).toEqual({ error: "not-found" });
  });
});

describe("listReports / getReport", () => {
  it("lists reports with their sites in order", async () => {
    const list = await listReports();
    const r = list.find((x) => x.id === ids.report)!;
    expect(r).toMatchObject({ clientName: "PT Kopi Sejahtera", lang: "id", recipients: ["owner@kopi.example"], autoSend: false, lastSend: null });
    expect(r.sites.map((s) => s.displayName)).toEqual(["Toko utama", "Toko online"]);
    expect((await getReport(ids.report))?.sites).toHaveLength(2);
    expect(await getReport("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("reportSendFacts (1.7, ReportSendFailed)", () => {
  it("gives the latest automatic send of each report that sends itself, and nothing for the others", async () => {
    const db = h.db as ReturnType<typeof drizzle>;
    const [auto] = await db.insert(reports).values({ clientName: "Auto Client", autoSend: true, recipients: ["a@example.com"], sender: "smtp" }).returning();
    await db.insert(reportSends).values([
      { reportId: auto.id, month: "2026-09", status: "sent", attempts: 1 },
      { reportId: auto.id, month: "2026-10", status: "failed", attempts: 3, lastError: "The mail server took too long to answer." },
      { reportId: ids.report, month: "2026-10", status: "failed", attempts: 3 }, // auto send is off: not a fact
    ]);
    expect(await reportSendFacts()).toEqual([{ reportId: auto.id, clientName: "Auto Client", month: "2026-10", status: "failed", lastError: "The mail server took too long to answer." }]);
  });
});

describe("report writes (1.7)", () => {
  it("creates, edits content and delivery separately, and deletes", async () => {
    const id = await createReport({ clientName: "Toko Baru", title: null, lang: "en", note: null, emailOpening: null, sites: [{ monitorId: ids.m1, displayName: "Main", position: 0 }] });
    expect((await getReport(id))?.sites.map((s) => s.displayName)).toEqual(["Main"]);
    await updateReportContent(id, { clientName: "Toko Baru", title: "Monthly", lang: "id", note: "n", emailOpening: null, sites: [{ monitorId: ids.m2, displayName: "Shop", position: 0 }, { monitorId: ids.m1, displayName: "Main", position: 1 }] });
    await updateReportDelivery(id, { recipients: ["a@toko.example"], autoSend: true, sender: "resend" });
    expect(await getReport(id)).toMatchObject({ title: "Monthly", lang: "id", recipients: ["a@toko.example"], autoSend: true, sender: "resend", sites: [{ displayName: "Shop" }, { displayName: "Main" }] });
    // Content edits never touch who gets the report.
    await updateReportContent(id, { clientName: "Toko Baru", title: null, lang: "en", note: null, emailOpening: null, sites: [] });
    expect(await getReport(id)).toMatchObject({ recipients: ["a@toko.example"], autoSend: true, sites: [] });
    expect(await deleteReport(id)).toBe(true);
    expect(await getReport(id)).toBeNull();
    expect(await deleteReport(id)).toBe(false);
  });
});

describe("reportMonitorOptions (1.7)", () => {
  it("lists the HTTP monitors as app · host/path for the editor", async () => {
    expect(await reportMonitorOptions()).toEqual([{ id: ids.m1, label: "kopi-web · kopisejahtera.id" }, { id: ids.m2, label: "kopi-web · shop.kopisejahtera.id" }]);
  });
});

describe("saving a report's websites (review I-5)", () => {
  it("is all or nothing: a website that no longer exists leaves the old list in place", async () => {
    const id = await createReport({ clientName: "Atomic", title: null, lang: "en", note: null, emailOpening: null, sites: [{ monitorId: ids.m1, displayName: "Main", position: 0 }] });
    await expect(updateReportContent(id, { clientName: "Atomic 2", title: null, lang: "en", note: null, emailOpening: null, sites: [{ monitorId: "00000000-0000-4000-8000-000000000000", displayName: "Gone", position: 0 }] })).rejects.toThrow();
    expect(await getReport(id)).toMatchObject({ clientName: "Atomic", sites: [{ displayName: "Main" }] });
  });
});

// Watchbell 1.7.1 (owner's test, T-1): before the daily job has summarised a day, its deploys are counted from the
// deployments still kept, so a fresh install or an upgrade never prints a silent "0 updates".
describe("readReportInput: updates before the daily summary (1.7.1)", () => {
  const db = () => h.db as ReturnType<typeof drizzle<typeof schema>>;
  const saved = [{ day: "2026-10-02", ok: 4, failed: 0 }, { day: "2026-10-23", ok: 1, failed: 1 }, { day: "2026-11-02", ok: 3, failed: 0 }];
  const deploy = (n: number, state: string, at: string) => ({ resourceId: ids.app, externalId: `dpl_${n}`, state, createdAtProvider: new Date(at) });
  const restore = async () => {
    await db().delete(schema.deployments);
    await db().delete(deployDays);
    await db().insert(deployDays).values(saved.map((s) => ({ resourceId: ids.app, ...s })));
  };

  it("counts updates from deployments when the daily summary is empty", async () => {
    try {
      await db().delete(deployDays);
      await db().insert(schema.deployments).values([deploy(1, "READY", "2026-10-14T03:00:00Z"), deploy(2, "READY", "2026-10-14T05:00:00Z"), deploy(3, "ERROR", "2026-10-14T06:00:00Z"), deploy(4, "BUILDING", "2026-10-14T07:00:00Z")]);
      const r = await readReportInput(ids.report, "2026-10", NOW, Z);
      if ("error" in r) throw new Error(r.error);
      expect(r.deploys.find((d) => d.monitorId === ids.m1)).toMatchObject({ ok: 2, failed: 1 });
      expect(r.dataFrom.updates).toBe("2026-10-14");
    } finally {
      await restore();
    }
  });

  it("adds the days after the newest summary from deployments, without counting a summarised day twice", async () => {
    try {
      await db().delete(deployDays);
      await db().insert(deployDays).values({ resourceId: ids.app, day: "2026-10-14", ok: 1, failed: 0 });
      await db().insert(schema.deployments).values([deploy(1, "READY", "2026-10-14T03:00:00Z"), deploy(2, "READY", "2026-10-20T03:00:00Z")]);
      const r = await readReportInput(ids.report, "2026-10", NOW, Z);
      if ("error" in r) throw new Error(r.error);
      expect(r.deploys.find((d) => d.monitorId === ids.m1)).toMatchObject({ ok: 2, failed: 0 });
      expect(r.dataFrom.updates).toBe("2026-10-14");
    } finally {
      await restore();
    }
  });

  it("says from when updates count even when an old live deployment is still kept (final review)", async () => {
    try {
      await db().delete(deployDays);
      await db().insert(schema.deployments).values([{ ...deploy(1, "READY", "2026-06-02T03:00:00Z"), isCurrent: true }, deploy(2, "READY", "2026-10-20T03:00:00Z"), deploy(3, "READY", "2026-10-21T03:00:00Z")]);
      const r = await readReportInput(ids.report, "2026-10", NOW, Z);
      if ("error" in r) throw new Error(r.error);
      expect(r.deploys.find((d) => d.monitorId === ids.m1)).toMatchObject({ ok: 2, failed: 0 });
      expect(r.dataFrom.updates).toBe("2026-10-14"); // 30 days of deployments kept before 13 Nov
    } finally {
      await restore();
    }
  });
});
