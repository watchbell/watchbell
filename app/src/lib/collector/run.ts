import "server-only";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { recordRunCpu } from "./cpu-budget-db";
import { accounts, collectorRuns, deployments, monitors, resources, settings, snapshots, checks as checksTable } from "@/db/schema";
import { monitorMoves, stickyPastDomains } from "@/lib/domain-move";
import { credentialProblem, statusAfterTest } from "@/lib/accounts";
import { expireTags } from "@/lib/cache/invalidate";
import { tagsForTasks } from "@/lib/cache/tags";
import { evaluateAlerts } from "@/lib/data/alerts-db";
import { taskHeartbeats } from "@/lib/data/heartbeats-db";
import { listRawWindows } from "@/lib/data/maintenance-db";
import { recordEvents } from "@/lib/data/events-write";
import { openOrNull } from "@/lib/crypto";
import { taskLogs } from "@/lib/data/logs-db";
import { deliverPending, taskDigest } from "@/lib/data/notify-db";
import { pausedSections } from "@/lib/data/sections-db";
import { type DeploymentOrigin, recordProductionSources } from "@/lib/data/production-source-db";
import { taskPageViews } from "@/lib/data/pageviews-db";
import { markAfterDeploy, marksPending, taskSecurity } from "@/lib/data/security-task";
import { taskStatus } from "@/lib/data/provider-status-db";
import { serverEnv } from "@/lib/env";
import { activeFor, type Window } from "@/lib/maintenance";
import { AFTER_DEPLOY_SETTING, type AfterDeploy, type DeployMark, deployToMark, parseAfterDeploy } from "@/lib/security/after-deploy";
import { type DeploymentState, getDeployment, listDeployments, listProjects, listTeams, type VercelDeployment, type VercelFailure } from "@/lib/providers/vercel";
import type { State } from "@/lib/status";
import { currentToFetch, deploymentChanged, missesAfter, pathOf, pickFlags, skippedIds } from "./deploy-sync";
import { appsWithPausedDatabase, type Ctx, taskFirebase, taskFirebaseUsage, taskNeon, taskSupabase, taskSupabaseUsage } from "./db-tasks";
import { taskExtraDbs } from "./extra-db-tasks";
import { checkUrl, mapLimit } from "./http-check";
import { acquireLease, releaseLease } from "./lease";
import { NETWORK_TASKS, refreshNetworkStates, taskCloudflare, taskDomains, taskEol, taskRdap, taskTls } from "./network";
import { taskNode } from "./node-runtime";
import { taskSelfUpdate } from "./self-update";
import { ruleFrom } from "@/lib/body-rule";
import { writeCheckResult } from "./monitor-write";
import { appState, deploymentEvent, monitorEvent, type NewEvent, nextMonitorState } from "./rules";
import { safeError } from "./safe-error";
import { ALERTS_RESERVE_MS, BUDGET_MS, checkTimeout, dueTasks, POST_TASKS, protectOnly, recheckable, type TaskName, taskFits, withAfterDeploy } from "./schedule";

export type RunSummary = { skipped: boolean; ok: boolean; tasks: string[]; checks: number; durationMs: number; errors: string[] };
// "builtin" is the self-host scheduler. collector_runs.trigger is a pg enum without it, so it is stored as "manual".
export type Trigger = "cron_job_org" | "qstash" | "manual" | "vercel_cron" | "builtin";

const LAST_RUN_KEY = "collector.lastRun";
const BACKOFF_KEY = "vercel.backoffUntil";
const MISS_KEY = "vercel.currentMiss";
const MAX_BACKOFF_S = 3600;
const BUILDING_FRESH_MS = 60 * 60_000;

const DB_TASKS: Partial<Record<TaskName, (ctx: Ctx) => Promise<void>>> = {
  supabase: taskSupabase, supabaseUsage: taskSupabaseUsage, neon: taskNeon, firebase: taskFirebase, firebaseUsage: taskFirebaseUsage, extraDbs: taskExtraDbs,
};

// When each task last ran, and (Watchbell 1.2.1) the apps waiting for their after-deploy security check, in one read.
async function readRunSettings(): Promise<{ lastRun: Partial<Record<TaskName, string>>; afterDeploy: unknown }> {
  const rows = await db().select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [LAST_RUN_KEY, AFTER_DEPLOY_SETTING])).limit(2);
  return {
    lastRun: (rows.find((r) => r.key === LAST_RUN_KEY)?.value as Partial<Record<TaskName, string>> | undefined) ?? {},
    afterDeploy: rows.find((r) => r.key === AFTER_DEPLOY_SETTING)?.value ?? null,
  };
}

async function writeLastRun(value: Partial<Record<TaskName, string>>) {
  await db().insert(settings).values({ key: LAST_RUN_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

const saveEvents = (list: (NewEvent | null)[]) => recordEvents(list);

// Each check's timeout is cut to what is left of the run; a monitor reached with under a second left isn't checked
// this time (no row, no state change). Monitors are taken least recently checked first (never-checked ones before
// all), so the ones a run had to skip lead the next run instead of being skipped every minute (final review I3).
// A forced run (Refresh now, the watchdog) skips monitors checked in the last 50 s, so pressing Refresh twice can't
// add failures faster than once a minute.
// Every result is a compare-and-set on the monitor as this run read it (monitor-write.ts): when Check now, Edit or
// Resume changed it during the run, this run's result is dropped (no checks row, no event) and theirs stands.
// U5 / B3: inside a maintenance window (`windows`, read once per run) checks still run and still move the monitor's
// state, so a site still down when the window ends alerts at once; their rows are marked in_maintenance, which keeps
// them out of uptime %.
export async function taskChecks(now: Date, deadline: number, errors: string[], force: boolean, windows: Window[] = []): Promise<number> {
  const list = (await db().select({ m: monitors, app: resources }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId))
    .where(and(eq(monitors.kind, "http"), eq(monitors.paused, false), eq(monitors.ownerPaused, false), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(sql`${monitors.lastCheckedAt} asc nulls first`, monitors.id))
    .filter(({ m }) => recheckable(m.lastCheckedAt, now, force));
  if (!list.length) return 0;
  const results = await mapLimit(list, 6, ({ m }) => {
    const timeoutMs = checkTimeout(m.timeoutMs, deadline, Date.now());
    return timeoutMs === null ? Promise.resolve(null) : checkUrl(m.url, { expectedStatus: m.expectedStatus, timeoutMs, body: ruleFrom(m) });
  });
  const ran = list.flatMap((item, i) => (results[i] ? [{ ...item, r: results[i] }] : []));
  if (ran.length < list.length) errors.push(`checks: ${list.length - ran.length} monitors skipped, time budget used`);
  if (!ran.length) return 0;
  const written: typeof ran = [];
  for (const item of ran) {
    if (await writeCheckResult(item.m, item.r, now)) written.push(item);
  }
  if (!written.length) return 0;
  await db().insert(checksTable).values(written.map(({ m, app, r }) => ({
    monitorId: m.id, at: now, ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error,
    inMaintenance: activeFor(windows, { monitorId: m.id, appId: app.id }, now) !== null,
  })));
  await saveEvents(written.map(({ m, app, r }) => monitorEvent({
    resourceId: app.id, path: pathOf(m.url), prev: m.state, next: nextMonitorState(m.failStreak, r).state, code: r.statusCode, error: r.error, at: now,
  })));
  return written.length;
}

// The tasks that write checks rows, and so need the maintenance windows: HTTP checks and heartbeats (B3 applies to both).
const WINDOW_TASKS: readonly TaskName[] = ["checks", "heartbeats"];

// B3 for heartbeats: taskHeartbeats asks this whether a heartbeat (monitor id, app id) is inside a window at `now`.
export function heartbeatMaintenance(windows: Window[], now: Date): (monitorId: string, appId: string) => boolean {
  return (monitorId, appId) => activeFor(windows, { monitorId, appId }, now) !== null;
}

// U5: the maintenance windows, one query per run, read only when a task that writes checks rows is due. A failed read
// never stops the checks: they run as if there were no windows (counted as usual, never silently left out of uptime)
// and the run reports one "maintenance:" line.
export async function windowsForRun(due: readonly TaskName[], errors: string[], read: () => Promise<Window[]> = listRawWindows): Promise<Window[]> {
  if (!WINDOW_TASKS.some((t) => due.includes(t))) return [];
  try {
    return await read();
  } catch (e) {
    errors.push(`maintenance: ${safeError(e)}`);
    return [];
  }
}

// Vercel asked us to slow down (HTTP 429 with Retry-After): remember until when, so the next runs don't keep asking.
async function backingOff(now: Date): Promise<boolean> {
  const [row] = await db().select().from(settings).where(eq(settings.key, BACKOFF_KEY)).limit(1);
  const until = (row?.value as { until?: string } | undefined)?.until;
  return !!until && now.getTime() < new Date(until).getTime();
}

async function startBackoff(failure: VercelFailure, now: Date): Promise<boolean> {
  if (failure.kind !== "transient" || !failure.retryAfterS) return false;
  const value = { until: new Date(now.getTime() + Math.min(failure.retryAfterS, MAX_BACKOFF_S) * 1000).toISOString() };
  await db().insert(settings).values({ key: BACKOFF_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  return true;
}

// true when the deployment's external id equals `id` (false for null), as an SQL expression for update statements
const isDeployment = (id: string | null) => sql<boolean>`coalesce(${deployments.externalId} = ${id}::text, false)`;

// The current / previous production flags of these apps, from the READY production deployments we know and what Vercel
// says is serving. Watchbell 1.2.1: an app whose current deployment just became current (or, review minor 2, a recent
// one whose mark was never saved) is marked for the security task (lib/data/security-task.ts), which checks it first in
// the next run, once per deployment. The marks collected are saved even when a later app's update throws.
export async function updateCurrentFlags(
  apps: readonly { id: string; externalId: string | null }[], ready: readonly { resourceId: string; id: string; createdAt: Date | null }[],
  current: ReadonlyMap<string, string | null>, o: { now: Date; afterDeploy: AfterDeploy; errors: string[]; label: string },
  mark: typeof markAfterDeploy = markAfterDeploy,
): Promise<void> {
  const marks: DeployMark[] = [];
  try {
    for (const app of apps) {
      const mine = ready.filter((r) => r.resourceId === app.id);
      const { currentId, previousId } = pickFlags(mine.map((r) => ({ id: r.id, createdAt: r.createdAt ?? new Date(0) })), (app.externalId ? current.get(app.externalId) : null) ?? null);
      const changed = await db().update(deployments)
        .set({ isCurrent: isDeployment(currentId), isPreviousProduction: isDeployment(previousId), updatedAt: o.now })
        .where(and(eq(deployments.resourceId, app.id), or(
          sql`${deployments.isCurrent} is distinct from ${isDeployment(currentId)}`,
          sql`${deployments.isPreviousProduction} is distinct from ${isDeployment(previousId)}`,
        ))).returning({ id: deployments.externalId });
      const id = deployToMark({
        appId: app.id, currentId, changedIds: changed.map((r) => r.id), createdAt: mine.find((r) => r.id === currentId)?.createdAt ?? null, state: o.afterDeploy, now: o.now,
      });
      if (id) marks.push({ appId: app.id, deploymentId: id });
    }
  } finally {
    if (marks.length) {
      try {
        await mark(marks, o.now);
      } catch (e) {
        o.errors.push(`vercel/${o.label}: after-deploy security check not scheduled: ${safeError(e)}`);
      }
    }
  }
}

// The branch origin of these deployments as Vercel gave them (toDeployment), by deployment id.
export const originsOf = (list: readonly VercelDeployment[]): Map<string, DeploymentOrigin> =>
  new Map(list.map((d) => [d.id, { ...(d.branchFrom ? { branchFrom: d.branchFrom } : {}), ...(d.gitDirty ? { gitDirty: true } : {}) }]));

// Watchbell 1.2.2 (D15): what the live production deployment of each of these apps was built from (a Git branch or the
// CLI) and when it was read, for the update PRs' base checks. Called by taskVercel after the current flags. A failed
// write is an error line, never a failed task; the next run tries again (and an old reading means "can't confirm").
// seen: where the branch came from, for the deployments read from Vercel in this run (fix round 3).
export async function saveProductionSources(
  apps: readonly { id: string; meta: Record<string, unknown> | null }[], now: Date, errors: string[], label: string,
  seen: ReadonlyMap<string, DeploymentOrigin> = new Map(), record: typeof recordProductionSources = recordProductionSources,
): Promise<void> {
  try {
    await record(apps, now, seen);
  } catch (e) {
    errors.push(`vercel/${label}: production source not saved: ${safeError(e)}`);
  }
}

async function taskVercel(now: Date, deadline: number, errors: string[], afterDeploy: AfterDeploy): Promise<void> {
  if (await backingOff(now)) return;
  const key = serverEnv().OPS_ENCRYPTION_KEY;
  const accs = await db().select().from(accounts).where(and(eq(accounts.provider, "vercel"), eq(accounts.status, "ok")));
  for (const acc of accs) {
    const token = openOrNull({ ciphertext: acc.credentialCiphertext, iv: acc.credentialIv }, key);
    if (credentialProblem(token) || !token) {
      errors.push(`vercel/${acc.label}: credential can't be read`);
      continue;
    }
    const apps = await db().select().from(resources).where(and(eq(resources.accountId, acc.id), eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt)));
    if (!apps.length) continue;
    const byProject = new Map(apps.map((a) => [a.externalId, a]));
    const teams = await listTeams(token);
    if (!teams.ok) {
      const change = statusAfterTest({ ok: false, kind: teams.kind, error: teams.error });
      if (change) await db().update(accounts).set({ ...change, updatedAt: now }).where(eq(accounts.id, acc.id));
      errors.push(`vercel/${acc.label}: ${teams.error}`);
      if (await startBackoff(teams, now)) return;
      continue;
    }
    const teamIds = new Set(apps.map((a) => String(a.meta.teamId)));
    for (const team of teams.data.filter((t) => teamIds.has(t.id))) {
      if (Date.now() > deadline) {
        errors.push("vercel: skipped remaining teams, time budget used");
        return;
      }
      const [projects, deps] = await Promise.all([
        listProjects(token, team),
        listDeployments(token, team, { since: now.getTime() - 7 * 86_400_000, limit: 100 }),
      ]);
      if (!projects.ok || !deps.ok) {
        const failure = (projects.ok ? deps : projects) as VercelFailure;
        errors.push(`vercel/${team.name}: ${failure.error}`);
        if (await startBackoff(failure, now)) return;
        continue;
      }
      const current = new Map(projects.data.map((p) => [p.id, p.currentDeploymentId]));
      const mine = deps.data.filter((d) => byProject.has(d.projectId));
      const seen = originsOf(mine); // D15 fix round 3: where each deployment's branch came from

      // Only new or changed deployments are written, which keeps the write volume of a minutely collector low.
      const stored = new Map((mine.length
        ? await db().select({
          externalId: deployments.externalId, state: deployments.state, target: deployments.target, branch: deployments.branch, commitSha: deployments.commitSha,
          commitMessage: deployments.commitMessage, source: deployments.source, url: deployments.url, buildingAt: deployments.buildingAt, readyAt: deployments.readyAt,
        }).from(deployments).where(inArray(deployments.externalId, mine.map((d) => d.id)))
        : []).map((r) => [r.externalId, r]));
      const evs: (NewEvent | null)[] = [];
      for (const d of mine) {
        const app = byProject.get(d.projectId)!;
        const before = stored.get(d.id);
        const fields = { state: d.state, target: d.target, branch: d.branch, commitSha: d.sha, commitMessage: d.message, source: d.source, url: d.url, buildingAt: d.buildingAt, readyAt: d.readyAt };
        if (deploymentChanged(before, fields)) {
          const row = { resourceId: app.id, externalId: d.id, ...fields, createdAtProvider: d.createdAt, updatedAt: now };
          await db().insert(deployments).values(row).onConflictDoUpdate({ target: deployments.externalId, set: row });
        }
        evs.push(deploymentEvent(before?.state as DeploymentState | undefined, d, app.id, now));
      }
      await saveEvents(evs);

      // current / previous production for every watched app of this team, not only those with deployments in the window:
      // a stored row that was current last time must lose the flag when something newer takes over.
      const teamApps = apps.filter((a) => String(a.meta.teamId) === team.id);
      const ready = await db().select({ resourceId: deployments.resourceId, id: deployments.externalId, createdAt: deployments.createdAtProvider }).from(deployments)
        .where(and(inArray(deployments.resourceId, teamApps.map((a) => a.id)), eq(deployments.target, "production"), eq(deployments.state, "ready")));
      // The poll only reaches back 7 days. The project's current production deployment can be older (an app that hasn't
      // been redeployed for months), and would then never be stored, so Last deploy read "—". Fetch it by id, once.
      // One that failed lately is skipped for about 6 h (settings `vercel.currentMiss`), so a deleted deployment costs one
      // call and one error line per 6 h, not one per minute. A 429 still goes through the shared backoff instead.
      const [missRow] = await db().select().from(settings).where(eq(settings.key, MISS_KEY)).limit(1);
      const failed: string[] = [];
      const saveMisses = () => failed.length
        ? db().insert(settings).values({ key: MISS_KEY, value: missesAfter(missRow?.value, failed, now) })
          .onConflictDoUpdate({ target: settings.key, set: { value: missesAfter(missRow?.value, failed, now), updatedAt: now } })
        : Promise.resolve();
      for (const want of currentToFetch(teamApps, current, ready, skippedIds(missRow?.value, now))) {
        if (Date.now() > deadline) break;
        const one = await getDeployment(token, team, want.deploymentId);
        if (!one.ok) {
          errors.push(`vercel/${team.name}: current deployment: ${one.error}`);
          if (await startBackoff(one, now)) {
            await saveMisses();
            return;
          }
          failed.push(want.deploymentId);
          continue;
        }
        const d = one.data;
        for (const [k, v] of originsOf([d])) seen.set(k, v);
        const row = {
          resourceId: want.appId, externalId: d.id, state: d.state, target: d.target, branch: d.branch, commitSha: d.sha, commitMessage: d.message,
          source: d.source, url: d.url, buildingAt: d.buildingAt, readyAt: d.readyAt, createdAtProvider: d.createdAt, updatedAt: now,
        };
        await db().insert(deployments).values(row).onConflictDoUpdate({ target: deployments.externalId, set: row });
        // No event: this is a back-fill of something that went live long ago, not news.
        if (d.state === "ready" && d.target === "production") ready.push({ resourceId: want.appId, id: d.id, createdAt: d.createdAt });
        else failed.push(want.deploymentId); // stored, but not what the READY query looks for: don't fetch it again every minute
      }
      await saveMisses();
      await updateCurrentFlags(teamApps, ready, current, { now, afterDeploy, errors, label: team.name });
      await saveProductionSources(teamApps, now, errors, team.name, seen);
    }
  }
}

// The minute's own facts (last status, latency, paused database) are merged into the snapshot's data (jsonb ||), not
// written over it: the slower reads keep their keys there (the page views of the `pageviews` task).
export async function refreshAppSnapshots(now: Date): Promise<void> {
  const apps = await db().select().from(resources).where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt)));
  if (!apps.length) return;
  const mons = await db().select().from(monitors).where(and(inArray(monitors.resourceId, apps.map((a) => a.id)), eq(monitors.paused, false), eq(monitors.ownerPaused, false)));
  // A build older than an hour that still reads "building" was never updated (it fell out of the deployment window
  // or was dropped), so it no longer makes the app look like it is deploying.
  const building = new Set((await db().select({ r: deployments.resourceId }).from(deployments)
    .where(and(
      inArray(deployments.resourceId, apps.map((a) => a.id)), eq(deployments.target, "production"), eq(deployments.state, "building"),
      gte(deployments.createdAtProvider, new Date(now.getTime() - BUILDING_FRESH_MS)),
    ))).map((r) => r.r));
  // D7: an app whose linked (and still watched) database is paused, or was before the provider stopped answering, is degraded.
  const dbPaused = await appsWithPausedDatabase(apps.map((a) => a.id));
  const prev = new Map((await db().select().from(snapshots).where(inArray(snapshots.resourceId, apps.map((a) => a.id)))).map((s) => [s.resourceId, s]));
  // Watchbell 1.2.1: a monitor on a host its app no longer has (lib/domain-move.ts) reads "Domain changed": the app is
  // degraded, not down, until the monitor is updated.
  const byId = new Map(apps.map((a) => [a.id, a]));
  const moved = monitorMoves(mons.map((m) => ({ id: m.id, kind: m.kind, url: m.url, appId: m.resourceId, appName: byId.get(m.resourceId)?.name ?? "", appMeta: byId.get(m.resourceId)?.meta, lastError: m.lastError })), apps);
  const stateOf = (m: (typeof mons)[number]): State => (moved.has(m.id) && m.state === "err" ? "warn" : m.state);
  // Review T3 I2: a host Vercel says it doesn't serve (DEPLOYMENT_NOT_FOUND) is remembered in the app's pastDomains, so
  // a timeout or 5xx in between doesn't flip the monitor back to MonitorDown.
  const sticky = stickyPastDomains(mons.map((m) => ({ id: m.id, kind: m.kind, url: m.url, appId: m.resourceId, appName: byId.get(m.resourceId)?.name ?? "", appMeta: byId.get(m.resourceId)?.meta, lastError: m.lastError })), apps);
  for (const [appId, pastDomains] of sticky) {
    await db().update(resources).set({ meta: sql`${resources.meta} || ${JSON.stringify({ pastDomains })}::jsonb` }).where(eq(resources.id, appId));
  }
  for (const app of apps) {
    const own = mons.filter((m) => m.resourceId === app.id);
    const state: State = appState({ monitors: own.map(stateOf), building: building.has(app.id), dbPaused: dbPaused.has(app.id) });
    const worst = own.find((m) => m.state === "err") ?? own.find((m) => m.state === "warn");
    // A heartbeat (U3) has no response time, so the app's comes from an HTTP check.
    const data = { code: worst?.lastStatus ?? null, latencyMs: own.find((m) => m.kind !== "heartbeat")?.lastLatencyMs ?? null, dbPaused: dbPaused.has(app.id) };
    const before = prev.get(app.id);
    await db().insert(snapshots).values({ resourceId: app.id, state, data, collectedAt: now, stateSince: now })
      .onConflictDoUpdate({ target: snapshots.resourceId, set: { state, data: sql`${snapshots.data} || ${JSON.stringify(data)}::jsonb`, collectedAt: now, ...(before?.state !== state ? { stateSince: now } : {}) } });
  }
}

// After the tasks: save when each one ran, then derive the app and network states. The save comes FIRST and each
// derivation has its own catch: a throw in a derivation (say a snapshot insert racing "Remove from console") must never
// stop the save, or the hourly, 6-hourly and daily tasks would be due again a minute later and spend the free-tier
// budget on every run (stage 4 review I1).
// Last, the cached reads (perf P3) of everything the tasks wrote are expired: `tried` counts a task that threw too,
// since it may have written part of its rows first.
type SettleDeps = {
  writeLastRun: typeof writeLastRun; refreshApps: typeof refreshAppSnapshots; refreshNetwork: typeof refreshNetworkStates; invalidate: typeof expireTags;
};
export async function settleRun(
  o: { lastRun: Partial<Record<TaskName, string>>; done: TaskName[]; tried?: TaskName[]; started: Date; errors: string[] },
  overrides: Partial<SettleDeps> = {},
): Promise<void> {
  const deps: SettleDeps = { writeLastRun, refreshApps: refreshAppSnapshots, refreshNetwork: refreshNetworkStates, invalidate: expireTags, ...overrides };
  try {
    await deps.writeLastRun({ ...o.lastRun, ...Object.fromEntries(o.done.map((t) => [t, o.started.toISOString()])) });
    try {
      await deps.refreshApps(new Date());
    } catch (e) {
      o.errors.push(`app-snapshots: ${safeError(e)}`);
    }
    if (o.done.some((t) => (NETWORK_TASKS as readonly string[]).includes(t))) {
      try {
        await deps.refreshNetwork(new Date());
      } catch (e) {
        o.errors.push(`network-states: ${safeError(e)}`);
      }
    }
  } finally {
    // Even when saving lastRun threw: the tasks wrote before it.
    deps.invalidate(tagsForTasks(o.tried ?? o.done));
  }
}

// The alert rules and the digest, after everything else. Evaluation and delivery are caught separately, so a rule that
// throws can't hold back notices that are already queued (I10). With no time left `alerts` is skipped (an error line,
// due again next minute); the digest steps aside when it doesn't fit (not an error).
export async function runPostTasks(
  post: readonly TaskName[], deadline: number, errors: string[],
  deps: { evaluate: typeof evaluateAlerts; deliver: typeof deliverPending; digest: typeof taskDigest } = { evaluate: evaluateAlerts, deliver: deliverPending, digest: taskDigest },
): Promise<TaskName[]> {
  const done: TaskName[] = [];
  if (post.includes("alerts")) {
    if (Date.now() > deadline) errors.push("alerts: skipped, time budget used");
    else {
      let ok = true;
      try {
        await deps.evaluate(new Date());
        console.info("collector alerts evaluated");
      } catch (e) {
        ok = false;
        errors.push(`alerts: ${safeError(e)}`);
      }
      try {
        await deps.deliver(new Date(), deadline);
        console.info("collector notifications delivered");
      } catch (e) {
        ok = false;
        errors.push(`notify: ${safeError(e)}`);
      }
      if (ok) done.push("alerts");
    }
  }
  if (post.includes("digest") && taskFits("digest", deadline, Date.now())) {
    try {
      await deps.digest(new Date());
      console.info("collector digest done");
      done.push("digest");
    } catch (e) {
      errors.push(`digest: ${safeError(e)}`);
    }
  }
  return done;
}

// The tasks before `alerts` and `digest`, in TASKS order, against the work deadline: a task reached after it is skipped
// with an error line (due again next run), one that needs more time than is left is deferred (not an error), and one
// that throws is reported. `tried` counts every task that started, `done` those that finished.
export async function runMainTasks(
  tasks: readonly TaskName[], workDeadline: number, errors: string[], runOne: (task: TaskName) => Promise<void>,
): Promise<{ done: TaskName[]; tried: TaskName[] }> {
  const done: TaskName[] = [];
  const tried: TaskName[] = [];
  for (const task of tasks) {
    if (Date.now() > workDeadline) {
      errors.push(`${task}: skipped, time budget used`);
      continue;
    }
    if (!taskFits(task, workDeadline, Date.now())) continue; // deferred: not run, not an error, due again next run
    tried.push(task);
    try {
      await runOne(task);
      done.push(task);
    } catch (e) {
      errors.push(`${task}: ${safeError(e)}`);
    }
  }
  return { done, tried };
}

export async function runCollector(trigger: Trigger): Promise<RunSummary> {
  const started = new Date();
  const owner = await acquireLease(started);
  if (!owner) return { skipped: true, ok: true, tasks: [], checks: 0, durationMs: 0, errors: [] };
  let run: { id: string };
  try {
    [run] = await db().insert(collectorRuns).values({ startedAt: started, trigger: trigger === "builtin" ? "manual" : trigger }).returning({ id: collectorRuns.id });
  } catch (e) {
    await releaseLease(owner).catch(() => undefined); // otherwise nothing could run until the lease expires
    throw e;
  }
  const errors: string[] = [];
  const done: TaskName[] = [];
  let checkCount = 0;
  const deadline = started.getTime() + BUDGET_MS;
  // Step timings in the function log (16 Oct incident: prod runs hung while the same code finished locally), with the CPU
  // the process used since the start (28 Oct: Vercel Hobby's 4 h of Active CPU a month ran out and its per-step numbers
  // need a paid plan). Process-wide, so a request served alongside the run on the same instance is counted too.
  const cpuStart = process.cpuUsage();
  const cpuMs = () => {
    const used = process.cpuUsage(cpuStart);
    return Math.round((used.user + used.system) / 1000);
  };
  const mark = (step: string) => console.info(`collector ${step} +${Date.now() - started.getTime()}ms cpu ${cpuMs()}ms`);
  try {
    mark("start");
    const { lastRun, afterDeploy } = await readRunSettings();
    const force = trigger !== "cron_job_org" && trigger !== "builtin"; // a scheduled tick respects each task's own interval
    // Watchbell 1.2 (D11): the tasks of a section the owner turned off are not due (schedule.ts TASK_SECTION).
    // A protective task of a paused section (schedule.ts PROTECT_TASKS) runs in protect-only mode.
    const paused = await pausedSections();
    // Watchbell 1.2.1: an app marked after a new production deployment brings the security task forward (early: the
    // marked apps only, and not saved as the task's last run, so its 6-hourly slot still comes).
    const { due, early } = withAfterDeploy(dueTasks(lastRun, started, force, paused), marksPending(afterDeploy), paused);
    // Fix round 1 (review important 1): a 6-hourly slot that didn't finish both lists isn't recorded either, so it
    // continues in the next minute runs.
    let securityComplete = false;
    const slotDone = (list: TaskName[]) => (early || !securityComplete ? list.filter((t) => t !== "security") : list);
    // I10: the tasks before `alerts` work to a deadline ALERTS_RESERVE_MS earlier, so the alert rules always get time.
    const post = due.filter((t) => POST_TASKS.includes(t));
    const workDeadline = post.includes("alerts") ? deadline - ALERTS_RESERVE_MS : deadline;
    const windows = await windowsForRun(due, errors);
    mark(`due ${due.join(",")}`);
    const { done: mainDone, tried } = await runMainTasks(due.filter((t) => !POST_TASKS.includes(t)), workDeadline, errors, async (task) => {
      mark(`task ${task}`);
      if (task === "heartbeats") {
        const now = new Date();
        checkCount += await taskHeartbeats(now, heartbeatMaintenance(windows, now), force);
      }
      if (task === "checks") checkCount += await taskChecks(new Date(), workDeadline, errors, force, windows);
      if (task === "vercel") await taskVercel(new Date(), workDeadline, errors, parseAfterDeploy(afterDeploy));
      const dbTask = DB_TASKS[task];
      if (dbTask) await dbTask({ now: new Date(), deadline: workDeadline, errors, protectOnly: protectOnly(task, paused) });
      if (task === "cloudflare") await taskCloudflare(new Date(), workDeadline, errors);
      if (task === "domains") await taskDomains(new Date(), workDeadline, errors);
      if (task === "tls") await taskTls(new Date(), workDeadline, errors);
      if (task === "rdap") await taskRdap(new Date(), workDeadline, errors);
      if (task === "eol") await taskEol(new Date(), workDeadline, errors);
      if (task === "node") {
        await taskNode(new Date(), workDeadline, errors);
        await taskSelfUpdate(new Date(), workDeadline, errors); // 1.2.3: self-hosted only, npm latest
      }
      if (task === "status") await taskStatus(new Date());
      if (task === "logs") await taskLogs(new Date(), workDeadline, errors);
      if (task === "pageviews") await taskPageViews(new Date(), workDeadline, errors);
      if (task === "security") securityComplete = (await taskSecurity({ now: started, deadline: workDeadline, errors, paused, early })).complete;
    });
    done.push(...mainDone);
    mark("main done");
    // lastRun is saved first; the app and network state refreshes each catch their own failure (settleRun).
    await settleRun({ lastRun, done: slotDone(done), tried, started, errors });
    // Then the alert rules, on the states just refreshed, and the digest, against the full deadline (runPostTasks).
    mark("settled");
    const postDone = await runPostTasks(post, deadline, errors);
    mark("post done");
    if (postDone.length) await writeLastRun({ ...lastRun, ...Object.fromEntries(slotDone([...done, ...postDone]).map((t) => [t, started.toISOString()])) });
    done.push(...postDone);
  } catch (e) {
    errors.push(`run: ${safeError(e)}`);
  } finally {
    const durationMs = Date.now() - started.getTime();
    await db().update(collectorRuns).set({ finishedAt: new Date(), ok: errors.length === 0, errorSummary: errors.join("\n").slice(0, 2000) || null, durationMs, tasks: done, checks: checkCount })
      .where(eq(collectorRuns.id, run.id)).catch(() => undefined);
    await releaseLease(owner).catch(() => undefined);
    // On Vercel, today's collector CPU (cpu-budget-db.ts): a warning event past half a Hobby day's share.
    if (process.env.VERCEL) await recordRunCpu(cpuMs());
  }
  return { skipped: false, ok: errors.length === 0, tasks: done, checks: checkCount, durationMs: Date.now() - started.getTime(), errors };
}

export { lastCollectorRunAt, lastMinuteRunAt } from "./last-run";
