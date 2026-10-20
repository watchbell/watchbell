import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { resources } from "@/db/schema";
import { listFiring, listResolved } from "@/lib/data/alerts-db";
import { listRecommendations } from "@/lib/data/advisor-db";
import { type AppSummary, getApp, listApps } from "@/lib/data/apps-db";
import { listDatabases } from "@/lib/data/databases-db";
import { listEvents } from "@/lib/data/events-db";
import { listStoredLogs } from "@/lib/data/logs-db";
import { listMonitors } from "@/lib/data/monitors-db";
import { DB_KINDS } from "@/lib/links";
import { clip, pathOnly, scrubLog } from "@/lib/logs/scrub";
import { type AliasBook, dbAlias, hideAlert, hideEvent, hideNames, hideRec } from "@/lib/view/display-name";
import { shortSha } from "@/lib/view/format";
import { problemsOf } from "@/lib/view/why";

// The console data the MCP read tools return (R5), server side. Built from the core readers the pages use, passed
// through the alias book (databases → db-a), hideEmails/hideNames and scrubLog; monitors are shown by PATH only (never
// a host or URL); no account labels, external ids, IPs, tokens or connection strings are selected into the output.
// tools.ts runs scrubDeep over every result as a last pass.
//
// NOTE for the merge (controller): Task 5's consoleSnapshot()/snap* readers serve the same purpose for
// /api/v1/status. They were not on this branch, so this module reads the core directly. Once T5 lands, these
// functions can delegate to snapApps/snapAlerts/… without changing the tool contract.

const HOUR = 3_600_000;
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppRef = { id: string; name: string };

// Watched apps by id and name: one small indexed read (used to resolve "app" arguments and name app ids).
export async function appRefs(): Promise<AppRef[]> {
  return db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true))).orderBy(resources.name).limit(200);
}

// An app argument: its id, or its name (case-insensitive). Null when it isn't a watched app.
export function resolveApp(refs: AppRef[], ref: string): AppRef | null {
  const r = ref.trim();
  if (UUID_RE.test(r)) return refs.find((a) => a.id.toLowerCase() === r.toLowerCase()) ?? null;
  return refs.find((a) => a.name.toLowerCase() === r.toLowerCase()) ?? null;
}

function problems(app: AppSummary, book: AliasBook, now: Date) {
  const database = app.database ? { id: app.database.id, kind: app.database.kind, name: dbAlias(book, app.database.id) } : null;
  const monitors = app.monitors.map((m) => ({ ...m, path: pathOnly(m.path) ?? "/" }));
  return problemsOf({ ...app, monitors, database }, now).map((p) => ({
    kind: p.kind, where: p.where, state: p.state, reason: p.reason, since: iso(p.since), remedies: p.remedies,
  }));
}

function appBrief(app: AppSummary, book: AliasBook, now: Date) {
  return {
    id: app.id, name: app.name, state: app.state, stateSince: iso(app.stateSince), gone: app.gone,
    uptime30d: app.uptime30, database: app.database ? dbAlias(book, app.database.id) : null,
    lastDeploy: app.lastDeploy ? { state: app.lastDeploy.state, at: iso(app.lastDeploy.createdAt) } : null,
    problems: problems(app, book, now).length,
  };
}

export async function listAppsData(book: AliasBook, now: Date) {
  return (await listApps(now)).map((a) => appBrief(a, book, now));
}

export async function appData(book: AliasBook, now: Date, id: string) {
  const app = await getApp(id, now);
  if (!app) return null;
  const recs = await listRecommendations(now, id);
  const d = app.lastDeploy;
  return {
    ...appBrief(app, book, now),
    framework: app.framework, productionBranch: app.productionBranch,
    response: { p50Ms: app.response.p50, p95Ms: app.response.p95 },
    database: app.database ? { alias: dbAlias(book, app.database.id), kind: app.database.kind, state: app.database.state, paused: app.dbPaused } : null,
    lastDeploy: d ? {
      state: d.state, branch: d.branch, commit: d.commitSha ? shortSha(d.commitSha) : null,
      message: d.commitMessage ? clip(scrubLog(hideNames(d.commitMessage, book)), 200) : null, at: iso(d.createdAt), readyAt: iso(d.readyAt),
    } : null,
    monitors: app.monitors.map((m) => monitorOf(m, app.name)),
    problems: problems(app, book, now),
    recommendations: recs.map((r) => recOf(hideRec(r, book), app.name)),
  };
}

type MonitorLike = AppSummary["monitors"][number] | Awaited<ReturnType<typeof listMonitors>>[number];
function monitorOf(m: MonitorLike, appName: string) {
  return {
    app: appName, kind: m.kind, path: pathOnly(m.path) ?? "/", name: m.name, state: m.state,
    lastStatus: m.lastStatus, lastLatencyMs: m.lastLatencyMs, lastError: m.lastError ? clip(scrubLog(m.lastError), 300) : null,
    paused: m.paused, lastCheckedAt: iso(m.lastCheckedAt), lastPingAt: iso(m.lastPingAt),
  };
}

export async function listMonitorsData(now: Date) {
  return (await listMonitors(now)).filter((m) => !m.appGone).map((m) => ({ ...monitorOf(m, m.appName), uptime30d: m.uptime30 }));
}

export async function listAlertsData(book: AliasBook, now: Date, state: "open" | "recent") {
  if (state === "open") {
    return (await listFiring()).map((raw) => {
      const a = hideAlert(raw, book);
      return {
        id: a.id, rule: a.ruleKey, severity: a.severity, title: a.title, message: a.message,
        app: raw.resourceKind === "app" ? raw.resourceName : null,
        startedAt: iso(a.startedAt), lastSeenAt: iso(a.lastSeenAt), silenced: a.silencedUntilResolved || (a.silencedUntil !== null && new Date(a.silencedUntil) > now),
      };
    });
  }
  return (await listResolved(now)).map((a) => ({
    id: a.id, rule: a.ruleKey, severity: a.severity,
    title: a.resourceId && book.db.some((d) => d.id === a.resourceId) ? dbAlias(book, a.resourceId) : hideNames(a.title, book, a.resourceId),
    startedAt: iso(a.startedAt), resolvedAt: iso(a.resolvedAt),
  }));
}

export async function recentEventsData(book: AliasBook, limit: number) {
  return (await listEvents(limit)).map((raw) => {
    const e = hideEvent(raw, book);
    return { at: iso(e.at), lastAt: iso(e.lastAt), count: e.count, type: e.type, kind: e.kind, resource: e.resource, message: e.message, detail: e.detail };
  });
}

// The stored log lines of the last 24 h (newest `limit`, oldest first), scrubbed. appId null = every app.
export async function recentLogsData(book: AliasBook, now: Date, appId: string | null, limit: number) {
  const lines = await listStoredLogs(now, { ...(appId ? { appId } : {}), sinceMs: 24 * HOUR });
  return lines.slice(-limit).map((l) => ({
    at: iso(l.at), level: l.level, app: l.app, method: l.method, path: pathOnly(l.path), status: l.status,
    message: clip(scrubLog(hideNames(l.message, book)), 500),
  }));
}

// Databases by alias only: never the real name, external id or the account they belong to.
export async function listDatabasesData(book: AliasBook) {
  const kinds = await Promise.all(DB_KINDS.map((k) => listDatabases(k)));
  return kinds.flat().map((d) => ({
    alias: dbAlias(book, d.id), kind: d.kind, state: d.state, stateSince: iso(d.stateSince), usedBy: d.usedBy.map((u) => u.name),
  }));
}

function recOf(r: { severity: string; subject: string; title: string; why: string; fix: string }, app: string | null) {
  return { severity: r.severity, app, subject: r.subject, title: r.title, why: r.why, fix: r.fix };
}

export async function advisorData(book: AliasBook, now: Date, appId: string | null, refs: AppRef[]) {
  const names = new Map(refs.map((a) => [a.id, a.name]));
  return (await listRecommendations(now, appId ?? undefined)).map((r) => recOf(hideRec(r, book), r.appId ? names.get(r.appId) ?? null : null));
}

// What an inbox question was built from, now: its app's state and problems, or its alert. Two reads at most for a
// page of questions (every app once, every open alert once), never one per question.
export async function questionContexts(book: AliasBook, now: Date, want: { kind: string; id: string | null }[]) {
  const appIds = new Set(want.filter((w) => w.kind === "app" && w.id).map((w) => w.id!));
  const alertIds = new Set(want.filter((w) => w.kind === "alert" && w.id).map((w) => w.id!));
  const [apps, alerts] = await Promise.all([
    appIds.size ? listApps(now) : Promise.resolve([] as AppSummary[]),
    alertIds.size ? listFiring() : Promise.resolve([] as Awaited<ReturnType<typeof listFiring>>),
  ]);
  const out = new Map<string, unknown>();
  for (const a of apps) if (appIds.has(a.id)) out.set(`app:${a.id}`, { ...appBrief(a, book, now), problems: problems(a, book, now) });
  for (const raw of alerts) {
    if (!alertIds.has(raw.id)) continue;
    const a = hideAlert(raw, book);
    out.set(`alert:${a.id}`, { id: a.id, rule: a.ruleKey, severity: a.severity, title: a.title, message: a.message, startedAt: iso(a.startedAt), open: true });
  }
  return out;
}
