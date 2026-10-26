import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { accounts, alerts as alertRows, appSecurity, deployments, events, links, monitors, resources, snapshots, storedLogs } from "@/db/schema";
import { readAliasBook } from "@/lib/data/aliases-db";
import { listFiring } from "@/lib/data/alerts-db";
import { fixableApps } from "@/lib/data/deps-db";
import { pausedSections } from "@/lib/data/sections-db";
import { alertPaused, type SectionId } from "@/lib/sections";
import { tokenFromSetting } from "@/lib/heartbeat";
import { tokenHash } from "@/lib/heartbeat-token";
import { type DomainMove, monitorMoves, storedDomains } from "@/lib/domain-move";
import { neonData, readData, supabaseData } from "@/lib/databases/snapshot-data";
import { type AliasBook, EMPTY_BOOK } from "@/lib/view/display-name";
import { actionProposals } from "@/private/db/schema";
import {
  autoRuns, factNeeds, type ProposalAlert, type ProposalDraft, type ProposalFacts, proposalsFor, type ProposalRow, resultSentence,
  RUN_STUCK_MS, type SuspendedNeon, toProposal, wakeableEndpoint,
} from "./proposals";
import {
  BASELINE_MS, COOLDOWN_MS, DB_ERROR_SQL, DB_ERRORS_MIN, ERRORS_MIN, freshLogDrafts, type LogApp, LOG_RULES, logProposalsFor, type LogRow, logsDue,
  NO_DEPLOY_MS, RECENT_MS, SPIKE_MIN, SPIKE_WINDOW_MS, staleLogIds,
} from "./log-proposals";
import { AUTO_ROLLBACK_GAP_MS, AUTO_ROLLBACK_RULES, autoRollbackDecision, autoRollbackReason, deployRef, type RollbackCheck } from "./auto-rollback";
import { notifyAutoRollback, notifyNewProposals, notifyProposalResult } from "./proposals-notify";
import { type Runner, runProposalAction, type RunTarget } from "./proposals-run";
import { autoBumpReady, frameworkFixes, type FrameworkFix, productionMismatches } from "@/lib/data/deps-pr";
import { type AutoRollback, readAutoRollback, readAutoRun, readAutoSecurity } from "./proposals-settings";
import {
  ALERT_HISTORY_MS, NEXT_EVENT_REASONS, type NextCheck, type NextEvent, type PreviousNext, previousNext, problemSince,
} from "./rollback-guard";
import type { Proposal } from "./proposals-types";

// Stage 9 slice 1: the proposals table (0030 ops.action_proposals). Status moves only forward, each step a
// compare-and-set on the status it expects: pending → approved | rejected | expired; approved → running (the claim:
// one process only) → done | failed. A proposal is made at most once per alert and action (a rejected or expired one is
// not proposed again while that alert fires; the partial unique index also stops two open ones racing in).

const KEEP_MS = 30 * 86_400_000; // daily retention
const LIST_WINDOW_MS = 7 * 86_400_000;

const ROW = {
  id: actionProposals.id, room: actionProposals.room, action: actionProposals.action, risk: actionProposals.risk, title: actionProposals.title,
  reason: actionProposals.reason, resourceName: actionProposals.resourceName, proposedBy: actionProposals.proposedBy, status: actionProposals.status,
  auto: actionProposals.auto, result: actionProposals.result, createdAt: actionProposals.createdAt, decidedAt: actionProposals.decidedAt,
  expiresAt: actionProposals.expiresAt,
};
// alertId (Watchbell 1.2.2, D18): an auto-run's Telegram notice answers its alert's message.
const RUN_ROW = { ...ROW, resourceId: actionProposals.resourceId, targetRef: actionProposals.targetRef, ruleKey: actionProposals.ruleKey, alertId: actionProposals.alertId };
type RunRow = ProposalRow & { resourceId: string | null; targetRef: string | null; ruleKey?: string; alertId?: string | null };

// ---- facts for the firing alerts (only what they need; nothing read when no alert needs it) ----
export async function readProposalFacts(alerts: ProposalAlert[], now: Date, rollbackWindowMs?: number): Promise<ProposalFacts> {
  const need = factNeeds(alerts, now);
  // Watchbell 1.2.2 (D17): the down / slow alerts whose start decides a rollback, and the earlier episodes of each.
  const deployApps = new Set(need.deployApps);
  const episodic = alerts.filter((a) => (a.ruleKey === "MonitorDown" || a.ruleKey === "HighLatency") && a.resourceId && deployApps.has(a.resourceId) && a.startedAt);
  const [mons, deps, refs, neon, fixable, dailyHb, framework, history, nextHistory] = await Promise.all([
    need.monitorIds.length
      ? db().select({ id: monitors.id, kind: monitors.kind, url: monitors.url, lastError: monitors.lastError, appId: monitors.resourceId, appName: resources.name, appMeta: resources.meta })
        .from(monitors).innerJoin(resources, eq(resources.id, monitors.resourceId)).where(inArray(monitors.id, need.monitorIds))
      : [],
    need.deployApps.length
      ? db().select({ app: deployments.resourceId, id: deployments.externalId, isCurrent: deployments.isCurrent, isPrevious: deployments.isPreviousProduction, readyAt: deployments.readyAt, createdAt: deployments.createdAtProvider })
        .from(deployments).where(and(inArray(deployments.resourceId, need.deployApps), or(eq(deployments.isCurrent, true), eq(deployments.isPreviousProduction, true))))
      : [],
    need.supabaseIds.length
      ? db().select({ id: resources.id, ref: resources.externalId }).from(resources)
        .where(and(inArray(resources.id, need.supabaseIds), eq(resources.kind, "supabase_project"), sql`${resources.goneAt} is null`))
      : [],
    need.monitorApps.length ? suspendedNeon(need.monitorApps) : new Map<string, SuspendedNeon>(),
    need.depApps.length
      ? frameworkAskedApps(alerts, need.depApps).catch(() => new Set<string>()).then((asked) => fixableApps(need.depApps, asked)).catch(() => new Map<string, string>())
      : new Map<string, string>(),
    need.monitorIds.length ? dailyHeartbeatId(need.monitorIds) : null,
    need.frameworkApps.length ? frameworkFixes(need.frameworkApps, need.depApps).catch(() => new Map<string, FrameworkFix>()) : new Map<string, FrameworkFix>(),
    episodic.length ? alertEpisodes(episodic.map((a) => a.subject), now).catch(() => []) : [],
    readNextHistory(need.deployApps),
  ]);
  // Watchbell 1.2.1: which of these monitors check a host their app no longer has (no redeploy for those; Update monitor).
  // The other watched apps are read only when one of these apps has stored domains.
  const withDomains = mons.some((m) => storedDomains(m.appMeta) !== null);
  const watchedApps = withDomains
    ? await db().select({ id: resources.id, name: resources.name, meta: resources.meta }).from(resources)
      .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt))).limit(500)
    : [];
  const moves = withDomains ? monitorMoves(mons, watchedApps) : new Map<string, DomainMove>();
  // Watchbell 1.2.2 (D15): the update-PR proposals whose merge would replace what is live say so first. Read only when
  // there is one; a failed read leaves the reasons as they were (the auto-run asks again, bumpPrAs checks the real base).
  const bumpPairs = [...[...fixable].map(([appId, repoId]) => ({ appId, repoId })), ...[...framework].map(([appId, fx]) => ({ appId, repoId: fx.repoId }))];
  const mismatch = bumpPairs.length
    ? await Promise.resolve().then(() => productionMismatches(bumpPairs, now)).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const deploys = new Map<string, { currentId: string | null; previousId: string | null; liveAt: Date | null }>();
  const previousLive = new Map<string, Date | null>();
  for (const d of deps) {
    const cur = deploys.get(d.app) ?? { currentId: null, previousId: null, liveAt: null };
    if (d.isCurrent) { cur.currentId = d.id; cur.liveAt = d.readyAt ?? d.createdAt ?? null; }
    else if (d.isPrevious) { cur.previousId = d.id; previousLive.set(d.app, d.readyAt ?? d.createdAt ?? null); }
    deploys.set(d.app, cur);
  }
  const prevNext = new Map<string, PreviousNext>();
  for (const [app, d] of deploys) {
    if (d.previousId) prevNext.set(app, nextOf(nextHistory, app, d.liveAt, previousLive.get(app) ?? null));
  }
  // Fix round 1 (review I2): a down check chains only an episode open at (or just before) the live deploy.
  const since = new Map(episodic.map((a) => [a.id, problemSince(a.startedAt!, history.filter((h) => h.ruleKey === a.ruleKey && h.subject === a.subject),
    { ruleKey: a.ruleKey, liveAt: deploys.get(a.resourceId!)?.liveAt ?? null })]));
  return {
    monitorKinds: new Map(mons.map((m) => [m.id, String(m.kind)])),
    deploys,
    ...(rollbackWindowMs !== undefined ? { rollbackWindowMs } : {}),
    supabaseRefs: new Map(refs.map((r) => [r.id, r.ref])),
    neonSuspended: neon,
    fixableRepos: fixable,
    dailyHeartbeatId: dailyHb,
    frameworkFixes: framework,
    monitorMoves: moves,
    problemSince: since,
    previousNext: prevNext,
    ...(mismatch.size ? { productionMismatch: mismatch } : {}),
  };
}

// Watchbell 1.2.2 (D17): the resolved episodes of these checks' down / slow alerts in the last 7 days (problemSince).
async function alertEpisodes(subjects: string[], now: Date) {
  return db().select({ ruleKey: alertRows.ruleKey, subject: alertRows.subject, startedAt: alertRows.startedAt, resolvedAt: alertRows.resolvedAt }).from(alertRows)
    .where(and(inArray(alertRows.ruleKey, ["MonitorDown", "HighLatency"]), inArray(alertRows.subject, [...new Set(subjects)]), isNotNull(alertRows.resolvedAt),
      gte(alertRows.resolvedAt, new Date(now.getTime() - ALERT_HISTORY_MS))))
    .orderBy(desc(alertRows.startedAt)).limit(500);
}

// Watchbell 1.2.2 (D17): what the Security card knows about these apps' Next.js: the stored check (one row each) and its
// transitions in Events (NextVulnerable / NextClean), newest first; and the framework Vercel builds each app with (fix
// rounds 1 and 2: a non-Next.js app, also after a failed check). A failed read is "nothing known" (unknown: no rollback runs by itself).
type NextHistory = { checks: Map<string, NextCheck>; events: Map<string, NextEvent[]>; frameworks: Map<string, string | null> };
export async function readNextHistory(appIds: string[]): Promise<NextHistory> {
  const out: NextHistory = { checks: new Map(), events: new Map(), frameworks: new Map() };
  if (!appIds.length) return out;
  try {
    const [checks, evs, apps] = await Promise.all([
      db().select({ app: appSecurity.resourceId, version: appSecurity.version, status: appSecurity.status, findings: appSecurity.findings, checkedAt: appSecurity.checkedAt, reason: appSecurity.reason })
        .from(appSecurity).where(inArray(appSecurity.resourceId, appIds)).limit(appIds.length),
      db().select({ app: events.resourceId, at: events.at, reason: events.reason, message: events.message }).from(events)
        .where(and(inArray(events.reason, [...NEXT_EVENT_REASONS]), inArray(events.resourceId, appIds))).orderBy(desc(events.at)).limit(Math.min(500, 50 * appIds.length)),
      db().select({ app: resources.id, meta: resources.meta }).from(resources).where(inArray(resources.id, appIds)).limit(appIds.length),
    ]);
    for (const c of checks) {
      out.checks.set(c.app, { version: c.version, status: c.status, findings: Array.isArray(c.findings) ? c.findings : [], checkedAt: c.checkedAt, reason: c.reason });
    }
    for (const e of evs) if (e.app) out.events.set(e.app, [...(out.events.get(e.app) ?? []), { at: e.at, reason: e.reason, message: e.message }]);
    for (const a of apps) {
      const fw = a.meta && typeof a.meta === "object" ? (a.meta as Record<string, unknown>).framework : null;
      out.frameworks.set(a.app, typeof fw === "string" ? fw : null);
    }
  } catch {
    return { checks: new Map(), events: new Map(), frameworks: new Map() };
  }
  return out;
}

const nextOf = (h: NextHistory, app: string, currentLiveAt: Date | null, previousLiveAt: Date | null): PreviousNext =>
  previousNext({ currentLiveAt, previousLiveAt, check: h.checks.get(app) ?? null, events: h.events.get(app) ?? [], framework: h.frameworks.get(app) ?? null });

// Review T1 minor 1: the apps (among these) whose firing FrameworkVulnerable alert already has an update-PR proposal that
// is pending, approved, running or done: their VulnerableDependency proposal leaves next out (fixableApps), so the owner
// isn't asked twice for the same package. Nothing read when no such alert fires.
export async function frameworkAskedApps(alerts: ProposalAlert[], appIds: string[]): Promise<Set<string>> {
  const apps = new Set(appIds);
  const ids = alerts.filter((a) => a.ruleKey === "FrameworkVulnerable" && a.resourceKind === "app" && a.resourceId && apps.has(a.resourceId)).map((a) => a.id);
  if (!ids.length) return new Set();
  const rows = await db().selectDistinct({ resourceId: actionProposals.resourceId }).from(actionProposals).where(and(
    eq(actionProposals.ruleKey, "FrameworkVulnerable"), eq(actionProposals.action, "github_bump_pr"), inArray(actionProposals.status, ["pending", "approved", "running", "done"]),
    inArray(actionProposals.alertId, ids), inArray(actionProposals.resourceId, [...apps]),
  )).limit(ids.length);
  return new Set(rows.flatMap((r) => (r.resourceId ? [r.resourceId] : [])));
}

// Owner 19 Oct: which of these monitors is the console's own daily-job heartbeat: the one whose stored hash is the hash
// of DAILY_HEARTBEAT_TOKEN, found the way recordPing finds it. Null when the setting is missing, unreadable or matches none.
async function dailyHeartbeatId(monitorIds: string[]): Promise<string | null> {
  const token = tokenFromSetting(process.env.DAILY_HEARTBEAT_TOKEN);
  if (!token) return null;
  const [m] = await db().select({ id: monitors.id }).from(monitors)
    .where(and(inArray(monitors.id, monitorIds), eq(monitors.kind, "heartbeat"), eq(monitors.tokenHash, tokenHash(token)))).limit(1)
    .catch(() => []);
  return m?.id ?? null;
}

// The apps' linked (uses_db) Neon databases whose compute the last snapshot shows suspended.
async function suspendedNeon(appIds: string[]): Promise<Map<string, SuspendedNeon>> {
  const rows = await db().select({ app: links.fromResourceId, id: resources.id, kind: resources.kind, externalId: resources.externalId, parentId: resources.parentId })
    .from(links).innerJoin(resources, eq(resources.id, links.toResourceId))
    .where(and(inArray(links.fromResourceId, appIds), eq(links.kind, "uses_db"), inArray(resources.kind, ["neon_project", "neon_branch"]), sql`${resources.goneAt} is null`));
  const out = new Map<string, SuspendedNeon>();
  if (!rows.length) return out;
  const projectOf = (r: (typeof rows)[number]) => (r.kind === "neon_branch" ? r.parentId : r.id);
  const projectIds = [...new Set(rows.map(projectOf).filter((x): x is string => !!x))];
  if (!projectIds.length) return out;
  const snaps = await db().select({ id: snapshots.resourceId, data: snapshots.data }).from(snapshots).where(inArray(snapshots.resourceId, projectIds));
  const byProject = new Map(snaps.map((s) => [s.id, readData(neonData, s.data)]));
  for (const r of rows) {
    const p = projectOf(r);
    const d = p ? byProject.get(p) : undefined;
    const ep = d ? wakeableEndpoint(d.endpoints, d.branches, r.kind === "neon_branch" ? r.externalId : null) : null;
    if (ep) out.set(r.app, { resourceId: r.id, resourceKind: r.kind as SuspendedNeon["resourceKind"], endpointId: ep });
  }
  return out;
}

// ---- create (dedupe) ----
// Inserts the drafts whose (alert, action) has never been proposed; returns the new rows.
export async function createProposals(drafts: ProposalDraft[]): Promise<RunRow[]> {
  if (!drafts.length) return [];
  const seen = await db().select({ alertId: actionProposals.alertId, action: actionProposals.action }).from(actionProposals)
    .where(inArray(actionProposals.alertId, [...new Set(drafts.map((d) => d.alertId))]));
  const had = new Set(seen.map((s) => `${s.alertId}:${s.action}`));
  const fresh = drafts.filter((d) => !had.has(`${d.alertId}:${d.action}`));
  if (!fresh.length) return [];
  return db().insert(actionProposals).values(fresh.map((d) => ({ ...d, status: "pending" as const }))).onConflictDoNothing().returning(RUN_ROW);
}

// ---- list ----
// Pending first, then newest; the last 7 days; at most `limit`.
export async function listProposals(now: Date, limit: number): Promise<Proposal[]> {
  const rows = await db().select(ROW).from(actionProposals)
    .where(sql`${actionProposals.createdAt} >= ${new Date(now.getTime() - LIST_WINDOW_MS).toISOString()}::timestamptz`)
    .orderBy(sql`case when ${actionProposals.status} = 'pending' then 0 else 1 end`, desc(actionProposals.createdAt), desc(actionProposals.id))
    .limit(limit);
  return rows.map(toProposal);
}

// ---- read one ----
// One proposal by id, whatever its age or status (the Auto-actions page's ?proposal= link from a Telegram notice).
export async function readProposal(id: string): Promise<Proposal | null> {
  const [row] = await db().select(ROW).from(actionProposals).where(eq(actionProposals.id, id)).limit(1);
  return row ? toProposal(row) : null;
}

// ---- decide ----
export type DecideOutcome = { status: "ok"; proposal: Proposal } | { status: "missing" } | { status: "conflict"; proposal: Proposal };

export async function decideProposal(id: string, decision: "approve" | "reject", memberId: string, now: Date): Promise<DecideOutcome & { row?: RunRow }> {
  const [row] = await db().update(actionProposals)
    .set({ status: decision === "approve" ? "approved" : "rejected", decidedBy: memberId, decidedAt: now })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "pending"), sql`${actionProposals.expiresAt} > ${now.toISOString()}::timestamptz`))
    .returning(RUN_ROW);
  if (row) return { status: "ok", proposal: toProposal(row), row };
  const [cur] = await db().select(ROW).from(actionProposals).where(eq(actionProposals.id, id)).limit(1);
  return cur ? { status: "conflict", proposal: toProposal(cur) } : { status: "missing" };
}

// ---- run: claim (approved → running, once), run, finish (running → done | failed) ----
export async function claimProposal(id: string, now: Date): Promise<RunRow | null> {
  const [row] = await db().update(actionProposals).set({ status: "running", claimedAt: now })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "approved"))).returning(RUN_ROW);
  return row ?? null;
}

export async function finishProposal(id: string, ok: boolean, result: string, now: Date): Promise<RunRow | null> {
  const [row] = await db().update(actionProposals).set({ status: ok ? "done" : "failed", result, finishedAt: now })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "running"))).returning(RUN_ROW);
  return row ?? null;
}

export type ExecDeps = { run: (t: RunTarget, who: Runner["member"]) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>; book: () => Promise<AliasBook> };
const EXEC: ExecDeps = { run: (t, who) => runProposalAction(t, who), book: () => readAliasBook() };

// Claims an approved proposal and runs it. Null when another process has it (or it isn't approved).
export async function executeProposal(id: string, who: Runner["member"], now: Date, deps: ExecDeps = EXEC): Promise<Proposal | null> {
  const row = await claimProposal(id, now);
  if (!row) return null;
  const r = await deps.run({ action: row.action, resourceId: row.resourceId, targetRef: row.targetRef, proposalId: row.id, ruleKey: row.ruleKey ?? null }, who);
  const book = await deps.book().catch(() => EMPTY_BOOK);
  const done = await finishProposal(id, r.ok, resultSentence(r, book), new Date());
  return done ? toProposal(done) : null;
}

// ---- expire ----
// Pending ones past their time or whose alert stopped firing → expired; a run that never finished → failed.
export async function expireProposals(firingIds: string[], now: Date): Promise<number> {
  const stale = await db().update(actionProposals).set({ status: "expired", result: "Expired: nobody decided in time, or the alert stopped firing." })
    .where(and(eq(actionProposals.status, "pending"), or(
      lt(actionProposals.expiresAt, new Date(now.getTime() + 1)),
      and(isNotNull(actionProposals.alertId), firingIds.length ? notInArray(actionProposals.alertId, firingIds) : sql`true`),
    ))).returning({ id: actionProposals.id });
  await db().update(actionProposals).set({ status: "failed", result: "The run was interrupted. Check the console page before trying again.", finishedAt: now })
    .where(and(eq(actionProposals.status, "running"), lt(actionProposals.claimedAt, new Date(now.getTime() - RUN_STUCK_MS))));
  return stale.length;
}

// Daily retention: proposals older than 30 days that are no longer open.
export async function pruneProposals(now: Date): Promise<void> {
  await db().delete(actionProposals).where(and(lt(actionProposals.createdAt, new Date(now.getTime() - KEEP_MS)),
    notInArray(actionProposals.status, ["pending", "approved", "running"])));
}

// ---- log proposals (log-proposals.ts): one aggregate read of ops.stored_logs' last 26 h, then, only for the few apps
// whose counts cross a threshold, their context in three small reads (in parallel) ----
const isErr = sql`(${storedLogs.level} in ('error', 'fatal') or coalesce(${storedLogs.statusCode}, 0) >= 500)`;
const liveAtSql = sql`coalesce(${deployments.readyAt}, ${deployments.createdAtProvider})`;

export async function readLogApps(now: Date): Promise<LogApp[]> {
  const since = new Date(now.getTime() - SPIKE_WINDOW_MS - BASELINE_MS);
  const recent = sql`${storedLogs.at} >= ${new Date(now.getTime() - RECENT_MS).toISOString()}::timestamptz`;
  const dbLine = sql`${storedLogs.message} ~* ${DB_ERROR_SQL}`;
  const msg = sql`left(${storedLogs.message}, 200)`;
  const rows = await db().select({
    appId: storedLogs.resourceId,
    appName: sql<string>`max(${resources.name})`,
    liveAt: sql<Date | null>`max(${liveAtSql})`.mapWith(deployments.readyAt),
    currentId: sql<string | null>`max(${deployments.externalId})`,
    errorsSinceLive: sql<number>`count(*) filter (where ${isErr} and ${storedLogs.at} >= ${liveAtSql})`.mapWith(Number),
    baselineErrors: sql<number>`count(*) filter (where ${isErr} and ${storedLogs.at} >= ${liveAtSql} - interval '24 hours' and ${storedLogs.at} < ${liveAtSql})`.mapWith(Number),
    topSinceLive: sql<string | null>`mode() within group (order by ${msg}) filter (where ${isErr} and ${storedLogs.at} >= ${liveAtSql})`,
    errors30: sql<number>`count(*) filter (where ${isErr} and ${recent})`.mapWith(Number),
    top30: sql<string | null>`mode() within group (order by ${msg}) filter (where ${isErr} and ${recent})`,
    dbErrors30: sql<number>`count(*) filter (where ${recent} and ${dbLine})`.mapWith(Number),
    topDb: sql<string | null>`mode() within group (order by ${msg}) filter (where ${recent} and ${dbLine})`,
  }).from(storedLogs)
    .innerJoin(resources, eq(resources.id, storedLogs.resourceId))
    .leftJoin(deployments, and(eq(deployments.resourceId, storedLogs.resourceId), eq(deployments.isCurrent, true)))
    .where(and(gte(storedLogs.at, since), eq(resources.kind, "app"), isNull(resources.goneAt)))
    .groupBy(storedLogs.resourceId);
  const hot = rows.filter((r) => r.errorsSinceLive >= SPIKE_MIN || r.errors30 >= ERRORS_MIN || r.dbErrors30 >= DB_ERRORS_MIN);
  if (!hot.length) return [];
  const ids = hot.map((r) => r.appId);
  const [deps, mons, dbs] = await Promise.all([
    db().select({
      app: deployments.resourceId,
      previousId: sql<string | null>`max(${deployments.externalId}) filter (where ${deployments.isPreviousProduction})`,
      previousLiveAt: sql<Date | null>`max(${liveAtSql}) filter (where ${deployments.isPreviousProduction})`.mapWith(deployments.readyAt),
      lastDeployAt: sql<Date | null>`max(${deployments.createdAtProvider}) filter (where ${deployments.target} = 'production')`.mapWith(deployments.createdAtProvider),
    }).from(deployments)
      .where(and(inArray(deployments.resourceId, ids), or(eq(deployments.isPreviousProduction, true), gte(deployments.createdAtProvider, new Date(now.getTime() - NO_DEPLOY_MS)))))
      .groupBy(deployments.resourceId),
    db().select({ app: monitors.resourceId, id: monitors.id }).from(monitors)
      .where(and(inArray(monitors.resourceId, ids), eq(monitors.kind, "http"), eq(monitors.paused, false), eq(monitors.ownerPaused, false)))
      .orderBy(monitors.createdAt),
    linkedDbs(ids),
  ]);
  const depBy = new Map(deps.map((d) => [d.app, d]));
  const monBy = new Map<string, string>();
  for (const m of mons) if (!monBy.has(m.app)) monBy.set(m.app, m.id);
  // D17: a spike's rollback needs the previous deployment's Next.js (one more read pair, only for those apps).
  const spiking = hot.filter((r) => r.errorsSinceLive >= SPIKE_MIN && r.liveAt && depBy.get(r.appId)?.previousId).map((r) => r.appId);
  const nextHistory = spiking.length ? await readNextHistory(spiking) : null;
  return hot.map((r) => ({
    ...r, appName: r.appName ?? "", previousId: depBy.get(r.appId)?.previousId ?? null, lastDeployAt: depBy.get(r.appId)?.lastDeployAt ?? null,
    httpMonitorId: monBy.get(r.appId) ?? null, db: dbs.get(r.appId) ?? null,
    ...(nextHistory && spiking.includes(r.appId) ? { previousNext: nextOf(nextHistory, r.appId, r.liveAt, depBy.get(r.appId)?.previousLiveAt ?? null) } : {}),
  }));
}

// Each app's linked database (uses_db, at most one): a Neon compute that can be woken, or a paused Supabase project.
async function linkedDbs(appIds: string[]): Promise<Map<string, NonNullable<LogApp["db"]>>> {
  const rows = await db().select({ app: links.fromResourceId, id: resources.id, kind: resources.kind, externalId: resources.externalId, parentId: resources.parentId })
    .from(links).innerJoin(resources, eq(resources.id, links.toResourceId))
    .where(and(inArray(links.fromResourceId, appIds), eq(links.kind, "uses_db"), inArray(resources.kind, ["neon_project", "neon_branch", "supabase_project"]), isNull(resources.goneAt)));
  const out = new Map<string, NonNullable<LogApp["db"]>>();
  if (!rows.length) return out;
  const snapOf = (r: (typeof rows)[number]) => (r.kind === "neon_branch" ? r.parentId : r.id);
  const snapIds = [...new Set(rows.map(snapOf).filter((x): x is string => !!x))];
  const snaps = snapIds.length ? await db().select({ id: snapshots.resourceId, data: snapshots.data }).from(snapshots).where(inArray(snapshots.resourceId, snapIds)) : [];
  const dataBy = new Map(snaps.map((s) => [s.id, s.data]));
  for (const r of rows) {
    const raw = dataBy.get(snapOf(r) ?? "");
    if (r.kind === "supabase_project") {
      const d = readData(supabaseData, raw);
      out.set(r.app, { resourceId: r.id, kind: r.kind, wakeEndpoint: null, supabaseRef: r.externalId, supabasePaused: d.status === "INACTIVE" });
    } else {
      const d = readData(neonData, raw);
      out.set(r.app, { resourceId: r.id, kind: r.kind, wakeEndpoint: wakeableEndpoint(d.endpoints, d.branches, r.kind === "neon_branch" ? r.externalId : null), supabaseRef: null, supabasePaused: false });
    }
  }
  return out;
}

// The log proposals open now or closed within the cooldown (for the dedupe and the condition expiry).
export async function recentLogRows(now: Date): Promise<LogRow[]> {
  const closedAt = sql<Date | null>`coalesce(${actionProposals.finishedAt}, ${actionProposals.decidedAt}, ${actionProposals.expiresAt})`;
  return db().select({
    id: actionProposals.id, ruleKey: actionProposals.ruleKey, resourceId: actionProposals.resourceId, action: actionProposals.action, status: actionProposals.status,
    closedAt: closedAt.mapWith(actionProposals.finishedAt),
  }).from(actionProposals)
    .where(and(isNull(actionProposals.alertId), inArray(actionProposals.ruleKey, [...LOG_RULES]),
      or(inArray(actionProposals.status, ["pending", "approved", "running"]), sql`${closedAt} > ${new Date(now.getTime() - COOLDOWN_MS).toISOString()}::timestamptz`)));
}

export type LogStepDeps = { apps: typeof readLogApps; rows: typeof recentLogRows };
const LOG_DEPS: LogStepDeps = { apps: readLogApps, rows: recentLogRows };

// One log evaluation: drafts from the counts; pending ones whose condition stopped → expired; fresh ones inserted.
export async function runLogProposals(now: Date, book: AliasBook, deps: LogStepDeps = LOG_DEPS): Promise<{ created: RunRow[]; expired: number }> {
  const [apps, existing] = await Promise.all([deps.apps(now), deps.rows(now)]);
  const drafts = apps.flatMap((a) => logProposalsFor(a, book, now));
  const stale = staleLogIds(existing, drafts);
  let expired = 0;
  if (stale.length) {
    const rows = await db().update(actionProposals).set({ status: "expired", result: "Expired: the logs no longer show it.", finishedAt: now })
      .where(and(inArray(actionProposals.id, stale), eq(actionProposals.status, "pending"))).returning({ id: actionProposals.id });
    expired = rows.length;
  }
  const fresh = freshLogDrafts(drafts, existing, now);
  if (!fresh.length) return { created: [], expired };
  const created = await db().insert(actionProposals).values(fresh.map((d) => ({ ...d, status: "pending" as const }))).onConflictDoNothing().returning(RUN_ROW);
  return { created, expired };
}

// The minute step reads the logs at most once per 5 minutes (logsDue): a per-instance memo plus the clock's 5-minute
// slot, so the throttle itself costs no read.
let lastLogRead: number | null = null;
export function resetLogThrottle(): void {
  lastLogRead = null;
}
async function logsIfDue(now: Date, book: () => Promise<AliasBook>): Promise<{ created: RunRow[]; expired: number }> {
  if (!logsDue(now, lastLogRead)) return { created: [], expired: 0 };
  lastLogRead = now.getTime();
  return runLogProposals(now, await book());
}

// ---- the minute step ----
export type StepDeps = {
  firing: () => Promise<ProposalAlert[]>; book: () => Promise<AliasBook>; facts: typeof readProposalFacts; create: typeof createProposals;
  expire: typeof expireProposals; autoRun: typeof readAutoRun; approveAuto: (id: string, now: Date) => Promise<boolean>;
  execute: (id: string, now: Date) => Promise<Proposal | null>; notifyNew: typeof notifyNewProposals; notifyResult: typeof notifyProposalResult;
  logs: (now: Date, book: () => Promise<AliasBook>) => Promise<{ created: RunRow[]; expired: number }>;
  // Optional: an edition without a Dev officer leaves it out; spike proposals are still created and notified.
  queueDev?: (list: { proposalId: string; appId: string }[], now: Date) => Promise<Set<string>>;
  autoRollback?: () => Promise<AutoRollback>;
  rollbackContext?: typeof readRollbackContext;
  approveAutoRollback?: (id: string, reason: string, now: Date) => Promise<boolean>;
  notifyRollback?: typeof notifyAutoRollback;
  autoSecurity?: typeof readAutoSecurity;
  bumpReady?: typeof autoBumpReady;
  approveAutoBump?: (id: string, now: Date) => Promise<boolean>;
  // Watchbell 1.2.2 (D15): what merging this app's update PR would do to production, when it must not run on its own
  // (null: nothing against it). Left out: not asked.
  prodMismatch?: (appId: string, repoId: string) => Promise<string | null>;
  // Watchbell 1.2 (D11): the sections the owner turned off; their alerts get no new proposals (left out: none paused).
  paused?: () => Promise<Set<SectionId>>;
  // The provider of each account id (an account alert follows its provider's section), read only while something is paused.
  providers?: (accountIds: string[]) => Promise<Map<string, string>>;
};

async function approveAuto(id: string, now: Date): Promise<boolean> {
  const rows = await db().update(actionProposals).set({ status: "approved", auto: true, decidedAt: now })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "pending"), eq(actionProposals.risk, "safe"))).returning({ id: actionProposals.id });
  return rows.length > 0;
}

// ---- auto-rollback after a bad production deploy (auto-rollback.ts) ----
// What the guards need for these apps, in four small reads: the live and previous production deployments, the newest
// ready production deployment's time, recent console rollbacks / promotes (Events), and the auto-rollbacks of the last
// 30 days.
type RollbackApp = Omit<RollbackCheck, "setting" | "ruleKey" | "targetRef" | "inFlight">;

export async function readRollbackContext(appIds: string[], now: Date): Promise<{ apps: Map<string, RollbackApp>; inFlight: boolean }> {
  const since2h = new Date(now.getTime() - AUTO_ROLLBACK_GAP_MS);
  const [deps, newest, evs, autos, nextHistory] = await Promise.all([
    db().select({
      app: deployments.resourceId, id: deployments.externalId, sha: deployments.commitSha, state: deployments.state, isCurrent: deployments.isCurrent,
      isPrevious: deployments.isPreviousProduction, readyAt: deployments.readyAt, createdAt: deployments.createdAtProvider,
    }).from(deployments).where(and(inArray(deployments.resourceId, appIds), or(eq(deployments.isCurrent, true), eq(deployments.isPreviousProduction, true)))),
    db().select({ app: deployments.resourceId, at: sql<Date | null>`max(${deployments.createdAtProvider})`.mapWith(deployments.createdAtProvider) })
      .from(deployments).where(and(inArray(deployments.resourceId, appIds), eq(deployments.target, "production"), eq(deployments.state, "ready")))
      .groupBy(deployments.resourceId),
    db().select({ app: events.resourceId }).from(events)
      .where(and(eq(events.type, "action"), inArray(events.resourceId, appIds), gte(events.at, since2h), sql`${events.message} ~ ${ROLLED_OR_PROMOTED}`)),
    db().select({ app: actionProposals.resourceId, targetRef: actionProposals.targetRef, status: actionProposals.status, decidedAt: actionProposals.decidedAt })
      .from(actionProposals)
      .where(and(eq(actionProposals.action, "vercel_rollback"), eq(actionProposals.auto, true), gte(actionProposals.createdAt, new Date(now.getTime() - 31 * 86_400_000)))),
    readNextHistory(appIds),
  ]);
  const apps = new Map<string, RollbackApp>();
  for (const app of appIds) {
    const cur = deps.find((d) => d.app === app && d.isCurrent);
    const prev = deps.find((d) => d.app === app && d.isPrevious && !d.isCurrent);
    const mine = autos.filter((a) => a.app === app);
    apps.set(app, {
      deploy: cur ? {
        currentId: cur.id, currentSha: cur.sha, liveAt: cur.readyAt ?? cur.createdAt, currentCreatedAt: cur.createdAt,
        newestProdCreatedAt: newest.find((n) => n.app === app)?.at ?? null,
        previousId: prev?.id ?? null, previousState: prev?.state ?? null, previousCreatedAt: prev?.createdAt ?? null,
      } : null,
      rolledOrPromotedLately: evs.some((e) => e.app === app),
      autoLately: mine.some((a) => a.decidedAt !== null && a.decidedAt.getTime() >= since2h.getTime()),
      sameDeployBefore: !!prev && mine.some((a) => a.targetRef === prev.id),
      previousNext: cur && prev ? nextOf(nextHistory, app, cur.readyAt ?? cur.createdAt, prev.readyAt ?? prev.createdAt).status : "unknown",
    });
  }
  return { apps, inFlight: autos.some((a) => a.status === "approved" || a.status === "running") };
}

// The console's own audit messages for a rollback or a promote (vercel-action.ts / vercel-actions.ts), also when the
// office auto-run did it ("Office auto-run: Rolled back · …").
const ROLLED_OR_PROMOTED = "(Rolled back|Promoted|Preview promoted) ·";

// pending → approved (auto) for one vercel_rollback, only while no other auto-rollback is approved or running (the
// in-flight guard, in the same statement). Needs migration 0046 (the auto check allows vercel_rollback).
async function approveAutoRollback(id: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db().update(actionProposals).set({ status: "approved", auto: true, decidedAt: now, reason })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "pending"), eq(actionProposals.action, "vercel_rollback"),
      sql`not exists (select 1 from ops.action_proposals x where x.action = 'vercel_rollback' and x.auto and x.status in ('approved', 'running'))`))
    .returning({ id: actionProposals.id });
  return rows.length > 0;
}

// Runs the new rollback proposals that pass every guard, one at a time; each run is reported on Telegram. Never throws.
async function autoRollbacks(created: RunRow[], now: Date, left: () => number, deps: StepDeps): Promise<Proposal[]> {
  const rows = created.filter((r) => r.action === "vercel_rollback" && r.ruleKey && AUTO_ROLLBACK_RULES.has(r.ruleKey) && r.resourceId);
  if (!rows.length || !deps.autoRollback || !deps.rollbackContext || !deps.approveAutoRollback) return [];
  const setting = await deps.autoRollback().catch(() => null);
  if (!setting?.enabled || left() < 15_000) return [];
  const ran: Proposal[] = [];
  try {
    const ctx = await deps.rollbackContext([...new Set(rows.map((r) => r.resourceId!))], now);
    let inFlight = ctx.inFlight;
    for (const row of rows) {
      const app = ctx.apps.get(row.resourceId!);
      if (!app || left() < 12_000) continue;
      const decision = autoRollbackDecision({ setting, ruleKey: row.ruleKey ?? null, targetRef: row.targetRef, inFlight, ...app }, now);
      if (!decision.ok) {
        console.log(`${ACTIONS_COPY.logTag}/auto-rollback: skipped (${decision.why})`);
        continue;
      }
      const newRef = deployRef(app.deploy!);
      if (!(await deps.approveAutoRollback(row.id, autoRollbackReason(newRef, setting.windowMin, row.reason), new Date()))) continue;
      inFlight = true;
      const p = await deps.execute(row.id, new Date());
      if (!p) continue;
      ran.push(p);
      await (deps.notifyRollback ?? notifyAutoRollback)(p, { reason: row.reason, newRef }, {}, { alertId: row.alertId ?? null }).catch(() => undefined);
      // Never more than one per run: the next one waits for the next minute (and the 2 h rule per app).
      break;
    }
  } catch (e) {
    console.warn(`${ACTIONS_COPY.logTag}/auto-rollback failed:`, e instanceof Error ? e.name : "error");
  }
  return ran;
}

// Automatic security fixes (owner 16 Oct): pending → approved (auto) for one update-PR proposal. Needs 0047.
async function approveAutoBump(id: string, now: Date): Promise<boolean> {
  const rows = await db().update(actionProposals).set({ status: "approved", auto: true, decidedAt: now })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.status, "pending"), eq(actionProposals.action, "github_bump_pr"))).returning({ id: actionProposals.id });
  return rows.length > 0;
}

// The new update-PR proposals that "Automatic security fixes" may open without asking (autoBumpReady); the rest wait.
async function autoBumps(created: RunRow[], left: () => number, deps: StepDeps): Promise<Proposal[]> {
  const rows = created.filter((r) => r.action === "github_bump_pr" && r.targetRef);
  if (!rows.length || !deps.autoSecurity || !deps.bumpReady || !deps.approveAutoBump) return [];
  const setting = await deps.autoSecurity().catch(() => null);
  if (!setting?.enabled || !setting.severities.length) return [];
  const ran: Proposal[] = [];
  for (const row of rows) {
    if (left() < 15_000) break;
    try {
      // Watchbell 1.2.2 (D15): production wasn't built from the PR's base (another branch, or the CLI): the proposal waits
      // for the owner (its reason says why). An unreadable answer waits too.
      const mismatch = row.resourceId && deps.prodMismatch ? await deps.prodMismatch(row.resourceId, row.targetRef!).catch(() => "unknown") : null;
      if (mismatch) {
        console.log(`${ACTIONS_COPY.logTag}/auto-security: waits for the owner (production source)`);
        continue;
      }
      // Watchbell 1.2: a FrameworkVulnerable proposal is judged on the app's Next.js check, not the scan.
      const ready = row.ruleKey === "FrameworkVulnerable" && row.resourceId
        ? await deps.bumpReady(row.targetRef!, setting.severities, { appId: row.resourceId })
        : await deps.bumpReady(row.targetRef!, setting.severities);
      if (!ready.ok) {
        console.log(`${ACTIONS_COPY.logTag}/auto-security: waits for the owner (${ready.why})`);
        continue;
      }
      if (!(await deps.approveAutoBump(row.id, new Date()))) continue;
      const p = await deps.execute(row.id, new Date());
      if (p) ran.push(p);
    } catch (e) {
      console.warn(`${ACTIONS_COPY.logTag}/auto-security failed:`, e instanceof Error ? e.name : "error");
    }
  }
  return ran;
}

// Watchbell 1.2.2 (D15): why this app's update PR must not run on its own, read now (null: nothing against it).
export async function prodMismatchOf(appId: string, repoId: string): Promise<string | null> {
  return (await productionMismatches([{ appId, repoId }], new Date())).get(appId) ?? null;
}

// Watchbell 1.2: the providers of these accounts (CredentialExpiring follows its provider's section).
async function providersOf(ids: string[]): Promise<Map<string, string>> {
  const rows = await db().select({ id: accounts.id, provider: accounts.provider }).from(accounts).where(inArray(accounts.id, ids));
  return new Map(rows.map((r) => [r.id, r.provider as string]));
}

const STEP: StepDeps = {
  firing: () => listFiring(), book: () => readAliasBook(), facts: readProposalFacts, create: createProposals, expire: expireProposals,
  autoRun: readAutoRun, approveAuto, execute: (id, now) => executeProposal(id, "auto", now), notifyNew: notifyNewProposals, notifyResult: notifyProposalResult,
  logs: logsIfDue,
  autoRollback: () => readAutoRollback(), rollbackContext: readRollbackContext, approveAutoRollback, notifyRollback: notifyAutoRollback,
  autoSecurity: () => readAutoSecurity(), bumpReady: autoBumpReady, approveAutoBump, paused: pausedSections, providers: providersOf,
  prodMismatch: prodMismatchOf,
};
export { STEP as PROPOSAL_STEP_DEPS }; // for the wiring test

// Every minute (minuteSteps): proposals for the firing alerts, expiry, and the auto-run of the safe kinds the owner
// switched on. Cheap when nothing fires (one read of the firing alerts, one expiry update). Bounded by ctx.deadline: no
// run starts with under 8 s left. Never throws. Returns what happened, for the log line and the tests.
// Watchbell 1.2 (D11): the alerts of a section the owner turned off get no new proposals (and Hosting off skips the log
// check), but they still count as firing for the expiry, so their open proposals wait unchanged.
export async function runProposalsStep(now: Date, ctx: { deadline?: number } = {}, deps: StepDeps = STEP): Promise<{ created: number; expired: number; autoRan: number }> {
  const out = { created: 0, expired: 0, autoRan: 0 };
  const left = () => (ctx.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  const firing = await deps.firing();
  out.expired = await deps.expire(firing.map((a) => a.id), now);
  const paused = deps.paused ? await deps.paused().catch(() => new Set<SectionId>()) : new Set<SectionId>();
  const accountIds = [...new Set(firing.flatMap((a) => (a.accountId ? [a.accountId] : [])))];
  const providerOf = paused.size && accountIds.length && deps.providers ? await deps.providers(accountIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  const alerts = firing.filter((a) => !alertPaused(paused, a.ruleKey, a.accountId ? providerOf.get(a.accountId) : null));
  let bookP: Promise<AliasBook> | null = null;
  const book = () => (bookP ??= deps.book().catch(() => EMPTY_BOOK));
  const created: RunRow[] = [];
  // Only the alert kinds that can get a proposal read anything more.
  const needs = factNeeds(alerts, now);
  if (Object.values(needs).some((x) => x.length > 0)) {
    // The auto-rollback window also decides which down / slow apps get a rollback proposal.
    const rollback = needs.deployApps.length && deps.autoRollback ? await deps.autoRollback().catch(() => null) : null;
    const facts = await deps.facts(alerts, now, rollback ? rollback.windowMin * 60_000 : undefined);
    const b = await book();
    // Watchbell 1.2: an update PR needs GitHub, so none is proposed while DevOps is off, also for FrameworkVulnerable
    // (a Hosting rule: its alert keeps firing and notifying).
    const drafts = alerts.flatMap((a) => proposalsFor(a, facts, b, now)).filter((d) => !(d.action === "github_bump_pr" && paused.has("devops")));
    created.push(...(await deps.create(drafts)));
  }
  // The officers' log check (log-proposals.ts): at most every 5 minutes, only with time left; a failure stays here.
  if (left() > 10_000 && !paused.has("hosting")) {
    try {
      const logs = await deps.logs(now, book);
      created.push(...logs.created);
      out.expired += logs.expired;
    } catch (e) {
      console.warn(`${ACTIONS_COPY.logTag}/proposals logs failed:`, e instanceof Error ? e.name : "error");
    }
  }
  out.created = created.length;
  if (!created.length) return out;
  const autoRun = await deps.autoRun().catch(() => null);
  // Auto-rollback first (owner 16 Oct): a broken new deploy goes back before anything else runs.
  const rolled = await autoRollbacks(created, now, left, deps);
  out.autoRan += rolled.length;
  const bumped = await autoBumps(created.filter((r) => !rolled.some((p) => p.id === r.id)), left, deps);
  const rolledIds = new Set(rolled.map((p) => p.id));
  const ran: Proposal[] = [...bumped];
  out.autoRan += bumped.length;
  for (const p of bumped) rolledIds.add(p.id);
  for (const row of created) {
    if (rolledIds.has(row.id)) continue;
    if (!autoRun || !autoRuns(row.action, autoRun) || left() < 8_000) continue;
    if (!(await deps.approveAuto(row.id, new Date()))) continue;
    const p = await deps.execute(row.id, new Date());
    if (p) {
      ran.push(p);
      out.autoRan++;
    }
  }
  const ranIds = new Set([...ran.map((p) => p.id), ...rolledIds]);
  // Slice 3: an error spike after a deploy also asks the Dev officer to read the code (queued; devMinuteStep runs it).
  const spikes = created.filter((r) => r.ruleKey === "LogErrorSpike" && r.resourceId).map((r) => ({ proposalId: r.id, appId: r.resourceId! }));
  const devQueued = spikes.length && deps.queueDev ? await deps.queueDev(spikes, now).catch(() => new Set<string>()) : new Set<string>();
  // D18: each notice answers its alert's Telegram message (proposal id → alert id; a log proposal has none).
  const alertIds = new Map(created.map((r) => [r.id, r.alertId ?? null]));
  await deps.notifyNew(created.filter((r) => !ranIds.has(r.id)).map(toProposal), {}, { devQueued, alertIds }).catch(() => undefined);
  for (const p of ran) await deps.notifyResult(p, {}, { alertId: alertIds.get(p.id) ?? null }).catch(() => undefined);
  return out;
}

export function makeProposalsMinuteStep(hooks: { queueDev?: StepDeps["queueDev"] }): (now: Date, ctx?: { deadline?: number }) => Promise<void> {
  const deps: StepDeps = { ...STEP, queueDev: hooks.queueDev };
  return async (now, ctx) => {
    try {
      const r = await runProposalsStep(now, ctx ?? {}, deps);
      if (r.created || r.expired || r.autoRan) console.log(`${ACTIONS_COPY.logTag}/proposals: ${r.created} new, ${r.expired} expired, ${r.autoRan} auto-ran`);
    } catch (e) {
      console.warn(`${ACTIONS_COPY.logTag}/proposals failed:`, e instanceof Error ? e.name : "error");
    }
  };
}

export const proposalsMinuteStep = makeProposalsMinuteStep({});
