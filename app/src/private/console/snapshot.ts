import "server-only";
import { cache } from "react";
import { type Rec } from "@/lib/advisor/rules";
import { listRecommendations } from "@/lib/data/advisor-db";
import { listFiring } from "@/lib/data/alerts-db";
import { type AppSummary, listApps } from "@/lib/data/apps-db";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { listEvents } from "@/lib/data/events-db";
import { listStoredLogs } from "@/lib/data/logs-db";
import { listMonitors } from "@/lib/data/monitors-db";
import { DB_KINDS } from "@/lib/links";
import type { State } from "@/lib/status";
import { type AliasBook, dbAlias, hideAlert, hideEvent, hideRec } from "@/lib/view/display-name";
import { lastDeployText, shortSha } from "@/lib/view/format";
import { appStatus } from "@/lib/view/labels";
import { lastDays, UPTIME_DAYS, uptimePct } from "@/lib/view/uptime";
import { problemsOf } from "@/lib/view/why";
import type { ConsoleSnapshot, SnapshotApp } from "./types";
import { scrubText } from "./scrub";

// R5: the ONE place console data is turned into something an agent may read. /api/v1/status, /api/v1/advice, the MCP
// read tools, Ask AI and the Playground's console mode all call these readers. Everything passes through the alias
// book (db-a, account-1), hideEmails and scrubLog (scrubText), URLs are reduced to a path, and nothing here selects a
// credential. Each section is one read of the console's own readers (no query per app), memoised per request with
// React's cache so a route that asks for several sections, or the same one twice, reads it once.

export type SnapshotSection = "apps" | "monitors" | "alerts" | "advisor";
export const SNAPSHOT_SECTIONS: readonly SnapshotSection[] = ["apps", "monitors", "alerts", "advisor"];

export type SnapshotMonitor = {
  app: string; path: string; kind: "http" | "heartbeat"; state: "up" | "degraded" | "down" | "paused" | "unknown";
  lastStatus: number | null; latencyMs: number | null; uptime30d: number | null; lastCheckedAt: string | null;
};
export type SnapshotAlert = { title: string; severity: string; app: string | null; since: string; message: string };
export type SnapshotEvent = { at: string; type: string; kind: string; reason: string | null; count: number; source: string; message: string; detail: string | null };
export type SnapshotLog = { at: string; level: string; app: string; method: string | null; path: string | null; status: number | null; message: string };
export type SnapshotDatabase = { name: string; provider: string; state: string; since: string | null; usedBy: string[] };
export type SnapshotAdvice = NonNullable<ConsoleSnapshot["advisor"]>[number];
export type SnapshotAppDetail = SnapshotApp & {
  monitors: { path: string; kind: "http" | "heartbeat"; state: SnapshotMonitor["state"]; lastStatus: number | null; latencyMs: number | null; uptime30d: number | null }[];
};

const ALERT_ITEMS = 50;
const MAX_LIMIT = 100;
const clamp = (n: number) => Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : MAX_LIMIT, MAX_LIMIT));
const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

// The per-request reads. Keyed by a primitive (the instant in ms), because React's cache compares arguments by identity.
const bookOnce = cache(() => aliasBook());
const appsAt = cache((ms: number) => listApps(new Date(ms)));
const monitorsAt = cache((ms: number) => listMonitors(new Date(ms)));
const firingOnce = cache(() => listFiring());
const recsAt = cache((ms: number) => listRecommendations(new Date(ms)));

const APP_STATE: Partial<Record<State, SnapshotApp["state"]>> = { ok: "running", warn: "degraded", err: "down", build: "building", paused: "paused", maint: "paused" };
const MONITOR_STATE: Partial<Record<State, SnapshotMonitor["state"]>> = { ok: "up", warn: "degraded", err: "down" };
// idle: a Neon compute asleep (scale to zero, wakes on the first query) — normal, not "unknown" (owner 15 Oct)
const GENERIC_STATE: Partial<Record<State, string>> = { ok: "ok", warn: "degraded", err: "down", fail: "down", paused: "paused", idle: "idle" };

const toSnapApp = (app: AppSummary, book: AliasBook, now: Date): SnapshotApp => {
  const shown = appStatus(app);
  const problems = problemsOf({ ...app, database: app.database ? { id: app.database.id, kind: app.database.kind, name: dbAlias(book, app.database.id) } : null }, now);
  return {
    id: app.name,
    state: APP_STATE[shown.state] ?? "unknown",
    uptime30d: round2(app.uptime30),
    database: app.database ? dbAlias(book, app.database.id) : null,
    lastDeploy: app.lastDeploy ? `${shortSha(app.lastDeploy.commitSha)} · ${lastDeployText(app.lastDeploy, now)}` : null,
    problems: problems.map((p) => ({
      kind: p.kind, where: scrubText(p.where, book), what: scrubText(p.reason, book),
      fix: p.remedies.length ? scrubText(p.remedies.join("; "), book) : null,
    })),
  };
};

const monitorState = (m: { state: State; paused: boolean; ownerPaused: boolean }): SnapshotMonitor["state"] =>
  m.paused || m.ownerPaused ? "paused" : (MONITOR_STATE[m.state] ?? "unknown");

// ---- sections ----------------------------------------------------------------------------------------------------

const appsSection = cache(async (ms: number): Promise<SnapshotApp[]> => {
  const now = new Date(ms);
  const [apps, book] = await Promise.all([appsAt(ms), bookOnce()]);
  return apps.filter((a) => !a.gone).map((a) => toSnapApp(a, book, now));
});
export const snapApps = (now: Date): Promise<SnapshotApp[]> => appsSection(now.getTime());

const monitorsSection = cache(async (ms: number): Promise<ConsoleSnapshot["monitors"]> => {
  const [rows, book] = await Promise.all([monitorsAt(ms), bookOnce()]);
  const items: SnapshotMonitor[] = rows.filter((m) => !m.appGone).map((m) => ({
    app: m.appName, path: scrubText(m.path, book), kind: m.kind, state: monitorState(m), lastStatus: m.lastStatus, latencyMs: m.lastLatencyMs,
    uptime30d: round2(m.uptime30), lastCheckedAt: m.lastCheckedAt?.toISOString() ?? null,
  }));
  const count = (s: SnapshotMonitor["state"]) => items.filter((m) => m.state === s).length;
  // The counts cover every monitor; the list only the ones that need a look (not up), to keep the answer small.
  return { up: count("up"), degraded: count("degraded"), down: count("down"), paused: count("paused"), items: items.filter((m) => m.state !== "up") };
});
export const snapMonitors = (now: Date): Promise<ConsoleSnapshot["monitors"]> => monitorsSection(now.getTime());

const alertsSection = cache(async (): Promise<ConsoleSnapshot["alerts"]> => {
  const [rows, book] = await Promise.all([firingOnce(), bookOnce()]);
  const items: SnapshotAlert[] = rows.slice(0, ALERT_ITEMS).map((r) => {
    const a = hideAlert(r, book);
    return {
      title: scrubText(a.title, book), severity: r.severity, app: r.resourceKind === "app" ? r.resourceName : null,
      since: r.startedAt.toISOString(), message: scrubText(a.message, book),
    };
  });
  return { open: rows.length, critical: rows.filter((r) => r.severity === "critical").length, items };
});
export const snapAlerts = (): Promise<ConsoleSnapshot["alerts"]> => alertsSection();

const advisorSection = cache(async (ms: number): Promise<SnapshotAdvice[]> => {
  const [recs, apps, book] = await Promise.all([recsAt(ms), appsAt(ms), bookOnce()]);
  const nameOf = new Map(apps.map((a) => [a.id, a.name]));
  return recs.map((r: Rec) => {
    const h = hideRec(r, book);
    return { title: scrubText(h.title, book), app: (r.appId && nameOf.get(r.appId)) || "console", severity: r.severity };
  });
});
export const snapAdvisor = (now: Date): Promise<SnapshotAdvice[]> => advisorSection(now.getTime());

// Newest first, at most 100.
export async function snapEvents(limit = 20): Promise<SnapshotEvent[]> {
  const [rows, book] = await Promise.all([listEvents(clamp(limit)), bookOnce()]);
  return rows.map((r) => {
    const e = hideEvent(r, book);
    return {
      at: (e.lastAt ?? e.at).toISOString(), type: e.type, kind: e.kind, reason: e.reason, count: e.count, source: scrubText(e.resource, book),
      message: scrubText(e.message, book), detail: e.detail ? scrubText(e.detail, book) : null,
    };
  });
}

// Stored warning/error lines (already scrubbed and path-only when stored), newest first, at most 100; scrubbed again.
export async function snapLogs(limit = 20, now: Date = new Date(), appId?: string): Promise<SnapshotLog[]> {
  const [rows, book] = await Promise.all([listStoredLogs(now, { appId }), bookOnce()]);
  return rows.slice(-clamp(limit)).reverse().map((l) => ({
    at: l.at.toISOString(), level: l.level, app: l.app, method: l.method, path: l.path ? scrubText(l.path, book) : null, status: l.status,
    message: scrubText(l.message, book),
  }));
}

const PROVIDER: Record<(typeof DB_KINDS)[number], string> = {
  supabase_project: "supabase", neon_project: "neon", firestore: "firebase", turso_database: "turso", upstash_redis: "upstash", d1_database: "d1",
};

// Watched databases by alias (db-a): provider, state, and the apps that use them. No project ids, regions or accounts.
export async function snapDatabases(): Promise<SnapshotDatabase[]> {
  const [lists, book] = await Promise.all([Promise.all(DB_KINDS.map((k) => listDatabases(k))), bookOnce()]);
  return lists.flatMap((rows, i) => rows.map((d) => ({
    name: dbAlias(book, d.id), provider: PROVIDER[DB_KINDS[i]], state: GENERIC_STATE[d.state] ?? "unknown",
    since: d.stateSince?.toISOString() ?? null, usedBy: d.usedBy.map((u) => u.name),
  })));
}

// ---- the snapshot ------------------------------------------------------------------------------------------------

export async function consoleSnapshot(now: Date, include: readonly SnapshotSection[] = SNAPSHOT_SECTIONS): Promise<ConsoleSnapshot> {
  const want = new Set(include);
  const [apps, monitors, alerts, advisor] = await Promise.all([
    want.has("apps") ? snapApps(now) : Promise.resolve([]),
    want.has("monitors") ? snapMonitors(now) : Promise.resolve({ up: 0, degraded: 0, down: 0, paused: 0 }),
    want.has("alerts") ? snapAlerts() : Promise.resolve({ open: 0, critical: 0 }),
    want.has("advisor") ? snapAdvisor(now) : Promise.resolve(undefined),
  ]);
  return { generatedAt: now.toISOString(), apps, monitors, alerts, ...(advisor ? { advisor } : {}) };
}

// An app by its name (case-insensitive) or its console id (uuid). Watched apps only.
export async function resolveApp(key: string, now: Date): Promise<AppSummary | null> {
  const k = key.trim().toLowerCase();
  if (!k) return null;
  const apps = await appsAt(now.getTime());
  return apps.find((a) => !a.gone && (a.id.toLowerCase() === k || a.name.toLowerCase() === k)) ?? null;
}

// One app with its Why problems and monitors; null when the app isn't watched.
export async function appDetail(key: string, now: Date): Promise<SnapshotAppDetail | null> {
  const [app, book] = await Promise.all([resolveApp(key, now), bookOnce()]);
  if (!app) return null;
  return {
    ...toSnapApp(app, book, now),
    monitors: app.monitors.map((m) => ({
      path: scrubText(m.path, book), kind: m.kind, state: monitorState(m), lastStatus: m.lastStatus, latencyMs: m.lastLatencyMs,
      uptime30d: round2(uptimePct(lastDays(app.days.get(m.id), now, UPTIME_DAYS))),
    })),
  };
}
