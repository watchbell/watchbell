import "server-only";
import { and, desc, eq, gte, inArray, isNull, max, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, deployments, resources, settings, storedLogs } from "@/db/schema";
import { mapLimit } from "@/lib/collector/http-check";
import { openOrNull } from "@/lib/crypto";
import { recordEvents } from "@/lib/data/events-write";
import { serverEnv } from "@/lib/env";
import { clip, pathOnly, scrubLog } from "@/lib/logs/scrub";
import { readRequestLogs, type RuntimeLogLine } from "@/lib/providers/vercel-request-logs";
import { dayKey, dayStart } from "@/lib/time";

export const STORE_LEVELS = ["warning", "error", "fatal"] as const;
export const DAILY_CAP = 1000;
const MINUTE = 60_000;
// A request is stamped when it starts, and a long one (Hobby cuts at 30-60 s) or a slow index can reach the API after a newer
// request was already stored. Each read starts this far before where the last one ended; the unique row_id absorbs repeats.
const OVERLAP = 5 * MINUTE;
const MAX_LINES = 300;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MESSAGE_MAX = 2000;
// Spec §14 fallback: `ops.settings` key `logs.disabled` = true switches the copy off if Vercel's log history turns out to
// be unusable. The controller sets it through MCP.
const DISABLED_KEY = "logs.disabled";
// `ops.settings` key `logs_read_cursor`: { [appId]: ISO time of the last successful read }, so an app with no stored lines (a
// quiet one) doesn't re-read 24 h every 5 minutes.
const CURSOR_KEY = "logs_read_cursor";

export type Target = { appId: string; appName: string; teamId: string; projectId: string; deploymentId: string; token: string };

// Watched apps that have a current production deployment, with the one Vercel token (spec §7.1: one account).
export async function targets(appId: string | null): Promise<Target[]> {
  const [acc] = await db().select().from(accounts).where(and(eq(accounts.provider, "vercel"), eq(accounts.status, "ok"))).limit(1);
  const token = acc ? openOrNull({ ciphertext: acc.credentialCiphertext, iv: acc.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY) : null;
  if (!acc || !token) return [];
  const rows = await db().select({ appId: resources.id, appName: resources.name, projectId: resources.externalId, meta: resources.meta, deploymentId: deployments.externalId })
    .from(deployments).innerJoin(resources, eq(resources.id, deployments.resourceId))
    .where(and(eq(deployments.isCurrent, true), eq(resources.accountId, acc.id), eq(resources.monitored, true), isNull(resources.goneAt), ...(appId ? [eq(resources.id, appId)] : [])));
  return rows.map((r) => ({ appId: r.appId, appName: r.appName, projectId: r.projectId, deploymentId: r.deploymentId, teamId: String(r.meta.teamId ?? ""), token }));
}

const toRow = (t: Target, l: RuntimeLogLine) => ({
  resourceId: t.appId, deploymentId: l.deploymentId ?? t.deploymentId, rowId: l.rowId, at: l.at, level: l.level as (typeof STORE_LEVELS)[number],
  message: clip(scrubLog(l.message), MESSAGE_MAX), requestMethod: l.requestMethod, requestPath: pathOnly(l.requestPath ? scrubLog(l.requestPath) : null),
  statusCode: l.statusCode, source: l.source,
});

// The `logs` task (S5): reads Vercel's request-logs history (the endpoint behind `vercel logs`; the runtime-logs stream
// sends nothing on Hobby), per app, 3 apps at a time. Each app is read from 5 minutes before the later of its read cursor
// (last successful read) and its newest stored line, at most 24 h back (all Vercel keeps for a read), up to now,
// production only, warning/error/fatal. The overlap and later re-reads are absorbed by the unique row_id: lines already
// stored are dropped BEFORE the cap is applied, so they neither double-count nor trip it. At most DAILY_CAP a WIB day
// per app, newest first when not all fit. LogCapReached is raised only when new lines would pass the cap. When a read
// holds more than MAX_LINES lines the oldest are skipped and the run says so.
const readCursor = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && !Number.isNaN(Date.parse(e[1])))) : {};

export async function taskLogs(now: Date, deadline: number, errors: string[]): Promise<void> {
  const [off] = await db().select().from(settings).where(eq(settings.key, DISABLED_KEY)).limit(1);
  if (off?.value === true) return;
  const list = await targets(null);
  if (!list.length) return;
  const today = dayStart(dayKey(now));
  const counts = new Map((await db().select({ id: storedLogs.resourceId, n: sql<number>`count(*)::int` }).from(storedLogs)
    .where(and(inArray(storedLogs.resourceId, list.map((t) => t.appId)), gte(storedLogs.at, today))).groupBy(storedLogs.resourceId)).map((r) => [r.id, r.n]));
  const newest = new Map((await db().select({ id: storedLogs.resourceId, at: max(storedLogs.at) }).from(storedLogs)
    .where(inArray(storedLogs.resourceId, list.map((t) => t.appId))).groupBy(storedLogs.resourceId)).map((r) => [r.id, r.at]));
  const [cursorRow] = await db().select().from(settings).where(eq(settings.key, CURSOR_KEY)).limit(1);
  const cursor = readCursor(cursorRow?.value);
  const floor = now.getTime() - DAY;
  // The reader's own timeout is 8 s; skip an app when less than that (plus a margin) remains.
  const results = await mapLimit(list, 3, (t) => {
    if (Date.now() + 8500 > deadline) return Promise.resolve(null);
    const marks = [newest.get(t.appId)?.getTime(), cursor[t.appId] ? Date.parse(cursor[t.appId]) : undefined].filter((m): m is number => m !== undefined);
    const since = new Date(Math.max(marks.length ? Math.max(...marks) - OVERLAP : floor, floor));
    return readRequestLogs(t.token, t.teamId, t.projectId, { since, until: now, now, levels: STORE_LEVELS, environment: "production", maxRows: MAX_LINES });
  });
  const keeps = list.map((t, i) => {
    const r = results[i];
    if (!r) return [];
    if (!r.ok) { errors.push(`logs/${t.appName}: ${r.error}`); return []; }
    if (r.more) errors.push(`logs/${t.appName}: more than ${MAX_LINES} log lines since the last read; the oldest were skipped`);
    return r.lines.filter((l) => (STORE_LEVELS as readonly string[]).includes(l.level));
  });
  const ids = keeps.flat().map((l) => l.rowId);
  const have = new Set(ids.length ? (await db().select({ rowId: storedLogs.rowId }).from(storedLogs).where(inArray(storedLogs.rowId, ids))).map((r) => r.rowId) : []);
  const capped: string[] = [];
  for (const [i, t] of list.entries()) {
    const fresh = keeps[i].filter((l) => !have.has(l.rowId));
    if (!fresh.length) continue;
    const stored = counts.get(t.appId) ?? 0;
    const room = Math.max(0, DAILY_CAP - stored);
    const rows = (room >= fresh.length ? fresh : fresh.slice(fresh.length - room)).map((l) => toRow(t, l));
    if (rows.length) await db().insert(storedLogs).values(rows).onConflictDoNothing({ target: storedLogs.rowId });
    if (stored + fresh.length >= DAILY_CAP) capped.push(t.appId);
  }
  // Only after the lines are stored, so a failure in between re-reads rather than skips them.
  const read = list.filter((_, i) => results[i]?.ok);
  if (read.length) {
    const next: Record<string, string> = {};
    for (const t of list) if (cursor[t.appId]) next[t.appId] = cursor[t.appId]; // forget apps that are no longer watched
    for (const t of read) next[t.appId] = now.toISOString();
    await db().insert(settings).values({ key: CURSOR_KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
  }
  await recordEvents(capped.map((id) => ({ resourceId: id, type: "system" as const, kind: "warn" as const, message: "Stored-log limit reached",
    detail: `More than ${DAILY_CAP} warnings and errors today; the rest stay in Vercel only for its short log history (about a day on Hobby).`, reason: "LogCapReached" })));
}

export type LogLine = { id: string; at: Date; level: string; app: string; method: string | null; path: string | null; status: number | null; message: string };

export async function listStoredLogs(now: Date, opts: { appId?: string; sinceMs?: number } = {}): Promise<LogLine[]> {
  const since = new Date(now.getTime() - (opts.sinceMs ?? 7 * 24 * HOUR));
  const rows = await db().select({ l: storedLogs, app: resources.name }).from(storedLogs).innerJoin(resources, eq(resources.id, storedLogs.resourceId))
    .where(and(gte(storedLogs.at, since), ...(opts.appId ? [eq(storedLogs.resourceId, opts.appId)] : [])))
    .orderBy(desc(storedLogs.at)).limit(500);
  return rows.map(({ l, app }) => ({ id: l.rowId, at: l.at, level: l.level, app, method: l.requestMethod, path: l.requestPath, status: l.statusCode, message: l.message })).reverse();
}

// Logs → Last hour: a read of each target's request logs of the last hour (all levels, scrubbed, not stored), merged with
// the stored lines of the last hour, deduped on row id, oldest first, at most 500.
export async function liveLogs(now: Date, appId: string | null): Promise<{ lines: LogLine[]; readAt: Date; problems: string[] }> {
  const list = (await targets(appId)).slice(0, 6);
  const problems: string[] = [];
  const read = await mapLimit(list, 6, (t) => readRequestLogs(t.token, t.teamId, t.projectId, { since: new Date(now.getTime() - HOUR), until: now, now, environment: "production", maxRows: MAX_LINES, requests: true }));
  const live: LogLine[] = [];
  for (const [i, t] of list.entries()) {
    const r = read[i];
    if (!r.ok) { problems.push(`${t.appName}: ${r.error}`); continue; }
    for (const l of r.lines) {
      const row = toRow(t, l);
      live.push({ id: l.rowId, at: l.at, level: l.level, app: t.appName, method: row.requestMethod, path: row.requestPath, status: l.statusCode, message: row.message });
    }
  }
  const stored = await listStoredLogs(now, { appId: appId ?? undefined, sinceMs: HOUR });
  const byId = new Map([...stored, ...live].map((l) => [l.id, l]));
  const lines = [...byId.values()].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-500);
  return { lines, readAt: new Date(), problems };
}
