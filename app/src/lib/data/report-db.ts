import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, min, or } from "drizzle-orm";
import { db } from "@/db/client";
import { deployDays, reports, reportSends, reportSites } from "@/db/report-schema";
import { alerts, deployments, monitors, resources, rollupsHourly } from "@/db/schema";
import { summarizeDeploys } from "@/lib/collector/deploy-days";
import { monitorDays } from "@/lib/data/metrics-db";
import { readRetentionDays } from "@/lib/data/settings-db";
import type { ReportSendFact } from "@/lib/alerts/facts";
import type { ReportContent, ReportDelivery } from "@/lib/report/form";
import type { ReportInput } from "@/lib/report/model";
import type { RetentionDays } from "@/lib/settings/retention";
import { BAR_DAYS, type DayCount } from "@/lib/view/uptime";
import { monthDays, zoneDay, zoneMidnight } from "@/lib/zone-day";

// Watchbell 1.7 (spec §5): what a monthly client report reads. Only data Watchbell already keeps (hourly rollups,
// alerts, the daily deploy summary); sites leave here under the display name the owner typed.

export type ReportSite = { monitorId: string; displayName: string; position: number };
export type ReportRow = {
  id: string; clientName: string; title: string | null; lang: "id" | "en"; note: string | null; emailOpening: string | null;
  recipients: string[]; autoSend: boolean; sender: "smtp" | "resend" | null; sites: ReportSite[];
  lastSend: { month: string; status: "claimed" | "sent" | "failed"; sentAt: Date | null; lastError: string | null } | null;
};

const DAY_MS = 86_400_000;
const MAX_MONTHS = 3;
const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const prevMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// Finished months (the install's zone) whose first day is still inside the rollup retention, newest first, at most 3.
export function finishedMonths(now: Date, zone: string, keepDays: number): string[] {
  const oldest = zoneDay(new Date(now.getTime() - keepDays * DAY_MS), zone);
  const out: string[] = [];
  for (let m = prevMonth(zoneDay(now, zone).slice(0, 7)); out.length < MAX_MONTHS && `${m}-01` >= oldest; m = prevMonth(m)) out.push(m);
  return out;
}

// Review I-1/I-2: every section of an offered month must still be there: the day counts cover BAR_DAYS (the Uptime
// bars' 90 days), and alerts can be kept for less than the rollups. A shorter keep offers fewer months, never a month
// with silently missing incidents.
export const offeredKeepDays = (r: RetentionDays): number => Math.min(r.rollupsHourly, r.alerts, BAR_DAYS);

export async function reportMonths(now: Date, zone: string): Promise<string[]> {
  return finishedMonths(now, zone, offeredKeepDays(await readRetentionDays()));
}

async function rowsWithSites(where?: ReturnType<typeof eq>): Promise<ReportRow[]> {
  const list = await db().select().from(reports).where(where).orderBy(asc(reports.clientName));
  if (!list.length) return [];
  const ids = list.map((r) => r.id);
  const [sites, sends] = await Promise.all([
    db().select({ reportId: reportSites.reportId, monitorId: reportSites.monitorId, displayName: reportSites.displayName, position: reportSites.position })
      .from(reportSites).where(inArray(reportSites.reportId, ids)).orderBy(asc(reportSites.position)),
    db().select().from(reportSends).where(inArray(reportSends.reportId, ids)).orderBy(desc(reportSends.month)),
  ]);
  return list.map((r) => {
    const last = sends.find((s) => s.reportId === r.id);
    return {
      id: r.id, clientName: r.clientName, title: r.title, lang: r.lang, note: r.note, emailOpening: r.emailOpening,
      recipients: r.recipients, autoSend: r.autoSend, sender: r.sender,
      sites: sites.filter((s) => s.reportId === r.id).map(({ monitorId, displayName, position }) => ({ monitorId, displayName, position })),
      lastSend: last ? { month: last.month, status: last.status, sentAt: last.sentAt, lastError: last.lastError } : null,
    };
  });
}

// 1.8: `ws` = the workspace shown (null or absent = every report; the monthly send reads them all).
export const listReports = (ws: string | null = null): Promise<ReportRow[]> => rowsWithSites(ws ? eq(reports.workspaceId, ws) : undefined);
export async function getReport(id: string): Promise<ReportRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await rowsWithSites(eq(reports.id, id)))[0] ?? null;
}

export type ReportInputError = { error: "not-found" | "no-sites" | "month-too-old" };

// The month to report: a finished month inside retention, or the current month so far (a test send).
export async function readReportInput(id: string, month: string, now: Date, zone: string): Promise<ReportInput | ReportInputError> {
  const report = await getReport(id);
  if (!report) return { error: "not-found" };
  if (!report.sites.length) return { error: "no-sites" };
  const current = zoneDay(now, zone).slice(0, 7);
  if (month !== current && !(await reportMonths(now, zone)).includes(month)) return { error: "month-too-old" };

  const days = monthDays(month);
  const start = zoneMidnight(days[0], zone);
  const end = zoneMidnight(`${nextMonth(month)}-01`, zone);
  const monitorIds = report.sites.map((s) => s.monitorId);

  const [mons, dayCounts, hours, alertRows, summaryRows, [summary]] = await Promise.all([
    db().select({ id: monitors.id, resourceId: monitors.resourceId, intervalS: monitors.intervalS }).from(monitors).where(inArray(monitors.id, monitorIds)),
    monitorDays(monitorIds, now, zone),
    db().select({ monitorId: rollupsHourly.monitorId, hour: rollupsHourly.hour, p50: rollupsHourly.p50Ms }).from(rollupsHourly)
      .where(and(inArray(rollupsHourly.monitorId, monitorIds), gte(rollupsHourly.hour, start), lt(rollupsHourly.hour, end))),
    db().select({ ruleKey: alerts.ruleKey, subject: alerts.subject, startedAt: alerts.startedAt, resolvedAt: alerts.resolvedAt }).from(alerts)
      .where(and(inArray(alerts.ruleKey, ["MonitorDown", "HighLatency"]), inArray(alerts.subject, monitorIds), lt(alerts.startedAt, end), or(isNull(alerts.resolvedAt), gte(alerts.resolvedAt, start)))),
    db().select().from(deployDays).where(and(gte(deployDays.day, days[0]), lte(deployDays.day, days[days.length - 1]))),
    db().select({ first: min(deployDays.day), last: max(deployDays.day) }).from(deployDays),
  ]);

  // Owner's test (1.7.1, T-1): the daily job summarises a day only after it ran; the days after its newest summary
  // (all of them on a fresh install or right after an upgrade) are counted from the deployments still kept.
  const after = summary?.last ? zoneMidnight(nextDay(summary.last), zone) : null;
  const [fresh, keep] = await Promise.all([
    after && after >= end ? [] : db().select({ resourceId: deployments.resourceId, state: deployments.state, createdAtProvider: deployments.createdAtProvider }).from(deployments)
      .where(and(gte(deployments.createdAtProvider, after && after > start ? after : start), lt(deployments.createdAtProvider, end))),
    readRetentionDays(),
  ]);
  const deployRows = [...summaryRows, ...summarizeDeploys(fresh, zone).filter((d) => d.day >= days[0] && d.day <= days[days.length - 1] && (!summary?.last || d.day > summary.last))];
  // Final review: updates count from the summary's first day, or (none yet) from where the deployments table is still
  // complete. Never from the oldest deployment kept: the live one is never deleted, however old.
  const firstDeployDay = summary?.first ?? zoneDay(new Date(now.getTime() - keep.deployments * DAY_MS), zone);

  // Response per day: the mean of the hours' p50 in the install's zone.
  const p50 = new Map<string, Map<string, number[]>>();
  for (const r of hours) {
    if (r.p50 === null) continue;
    const byDay = p50.get(r.monitorId) ?? new Map<string, number[]>();
    const d = zoneDay(r.hour, zone);
    byDay.set(d, [...(byDay.get(d) ?? []), r.p50]);
    p50.set(r.monitorId, byDay);
  }

  // An app's deploys go to the first of the report's sites on that app, so two monitors of one app don't count twice.
  const firstSiteOfApp = new Map<string, string>();
  for (const s of report.sites) {
    const app = mons.find((m) => m.id === s.monitorId)?.resourceId;
    if (app && !firstSiteOfApp.has(app)) firstSiteOfApp.set(app, s.monitorId);
  }

  const sites = report.sites.flatMap((s) => {
    const mon = mons.find((m) => m.id === s.monitorId);
    if (!mon) return [];
    const all = dayCounts.get(s.monitorId) ?? new Map<string, DayCount>();
    const inMonth = new Map(days.filter((d) => all.has(d)).map((d) => [d, all.get(d) as DayCount]));
    const firstDay = days.find((d) => (inMonth.get(d)?.checks ?? 0) > 0) ?? null;
    const byDay = p50.get(s.monitorId);
    const p50ByDay = new Map(days.map((d) => {
      const v = byDay?.get(d);
      return [d, v?.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null] as const;
    }));
    return [{ monitorId: s.monitorId, name: s.displayName, intervalS: mon.intervalS, firstDay, days: inMonth, p50ByDay }];
  });

  const deploys = report.sites.map((s) => {
    const app = mons.find((m) => m.id === s.monitorId)?.resourceId;
    const mine = app && firstSiteOfApp.get(app) === s.monitorId ? deployRows.filter((r) => r.resourceId === app) : [];
    return { monitorId: s.monitorId, ok: mine.reduce((n, r) => n + r.ok, 0), failed: mine.reduce((n, r) => n + r.failed, 0), firstDay: mine[0]?.day ?? null };
  });

  return {
    month, zone, generatedAt: now, sites,
    incidents: alertRows.map((a) => ({
      monitorId: a.subject, kind: a.ruleKey === "MonitorDown" ? ("down" as const) : ("slow" as const),
      startedAt: a.startedAt < start ? start : a.startedAt, resolvedAt: a.resolvedAt, endedBy: a.resolvedAt ? ("resolved" as const) : ("open" as const),
    })),
    deploys,
    dataFrom: { uptime: null, updates: firstDeployDay && firstDeployDay > days[0] ? firstDeployDay : null },
  };
}

// Watchbell 1.7 (ReportSendFailed): the latest automatic send of each report that sends itself. Never the recipients.
export async function reportSendFacts(): Promise<ReportSendFact[]> {
  const rows = await db().select({ reportId: reportSends.reportId, month: reportSends.month, status: reportSends.status, lastError: reportSends.lastError, clientName: reports.clientName })
    .from(reportSends).innerJoin(reports, eq(reports.id, reportSends.reportId)).where(eq(reports.autoSend, true)).orderBy(desc(reportSends.month));
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.reportId) && seen.add(r.reportId));
}

// ---- writes (the Reports page; permissions are checked by its actions) ----

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

// In one transaction with the report row (review I-5): a website deleted meanwhile fails the save and leaves the old
// list, instead of an emptied report.
async function replaceSites(tx: Tx, reportId: string, sites: ReportContent["sites"]): Promise<void> {
  await tx.delete(reportSites).where(eq(reportSites.reportId, reportId));
  if (sites.length) await tx.insert(reportSites).values(sites.map((s) => ({ reportId, ...s })));
}

// 1.8: `ws` = the workspace the new report belongs to (absent: the default workspace, by the column default).
export async function createReport(c: ReportContent, ws?: string): Promise<string> {
  const { sites, ...row } = c;
  return db().transaction(async (tx) => {
    const [r] = await tx.insert(reports).values(ws ? { ...row, workspaceId: ws } : row).returning({ id: reports.id });
    await replaceSites(tx, r.id, sites);
    return r.id;
  });
}

// The content only: recipients, automatic sending and the sender stay as they are.
export async function updateReportContent(id: string, c: ReportContent): Promise<boolean> {
  const { sites, ...row } = c;
  return db().transaction(async (tx) => {
    const done = await tx.update(reports).set({ ...row, updatedAt: new Date() }).where(eq(reports.id, id)).returning({ id: reports.id });
    if (!done.length) return false;
    await replaceSites(tx, id, sites);
    return true;
  });
}

export async function updateReportDelivery(id: string, d: ReportDelivery): Promise<boolean> {
  const done = await db().update(reports).set({ ...d, updatedAt: new Date() }).where(eq(reports.id, id)).returning({ id: reports.id });
  return done.length > 0;
}

export async function deleteReport(id: string): Promise<boolean> {
  const done = await db().delete(reports).where(eq(reports.id, id)).returning({ id: reports.id });
  return done.length > 0;
}

// The Reports editor's list of uptime monitors (HTTP only): "app · host/path". Console-only; the PDF uses the
// display names the owner types instead.
export async function reportMonitorOptions(ws: string | null = null): Promise<{ id: string; label: string }[]> {
  const rows = await db().select({ id: monitors.id, url: monitors.url, app: resources.name }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId)).where(and(eq(monitors.kind, "http"), ws ? eq(resources.workspaceId, ws) : undefined)).orderBy(asc(resources.name), asc(monitors.url));
  return rows.map((r) => {
    let where = r.url;
    try {
      const u = new URL(r.url);
      where = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      // keep the stored text
    }
    return { id: r.id, label: `${r.app} · ${where}` };
  });
}
