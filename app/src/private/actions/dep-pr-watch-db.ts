import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { dependencyPrs, dependencyScans, githubRepos, monitors, resources } from "@/db/schema";
import { readAliasBook } from "@/lib/data/aliases-db";
import { recordAction } from "@/lib/data/audit-db";
import { pausedSections } from "@/lib/data/sections-db";
import type { SectionId } from "@/lib/sections";
import { actionsLockfilePending } from "@/lib/data/actions-lockfile-db";
import { writeAccount } from "@/lib/data/deps-pr";
import { repoReadAccess } from "@/lib/data/github-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import {
  checksVerdict, type HttpProbe, httpVerdict, isAuthWall, logsVerdict, MAX_REVIEW_COMMITS, type MergeReview, OPEN_STAGES, type PrCommit, type PrStage,
  SMOKE_TIMEOUT_MS, smokePaths, WATCH_TIMEOUT_MS, type SmokeVerdict, stageLine, unexpectedChange, lockfileChangeProblem, lockfileMissing, manifestChangeProblem, watchDue, type WatchStep, watchStep,
} from "@/lib/deps/pr-watch";
import { type ProductionSource, productionMismatch, productionSourceOf, readProductionSource } from "@/lib/deps/branch";
import { cleanRootDir, inDir } from "@/lib/deps/root-dir";
import { runsForCommit } from "@/lib/providers/github";
import { commitChecks, commitFiles, isNpmLockfilePath, lockfileAt, manifestAt, mergeWatchpostPull, pullCommits, pullFiles, pullState, tokenLogin } from "@/lib/providers/github-write";
import { deploymentsForCommit, getDeployment, productionDeployments, productionServing, runningProductionBuild, type VercelDeployment } from "@/lib/providers/vercel";
import { readRequestLogs } from "@/lib/providers/vercel-request-logs";
import { appAlias, EMPTY_BOOK } from "@/lib/view/display-name";
import { actionProposals } from "@/private/db/schema";
import { AUTO_AUDIT_PREFIX } from "./proposals";
import { type DepPrNotice, notifyDepPr } from "./proposals-notify";
import { readAutoRollback, readAutoSecurity } from "./proposals-settings";

// Automatic security fixes (owner 16 Oct): the merge watcher of Watchbell's open update PRs, a minute step throttled to
// every 2 minutes (pr-watch.ts watchDue). Per PR: GitHub's PR state and checks → Vercel's preview of the head commit →
// the smoke test → auto-rollback on → squash merge pinned to the head SHA the checks were read at. Each stage is stored
// on the PR row and on its proposal's result (the office card and the app page show it); a merge or a stop goes to
// Telegram once. Auto-opened PRs are always watched; PRs the owner approved only while "Automatic security fixes" is
// on. Never throws; a provider hiccup leaves the PR as it was for the next round.

const MAX_PRS = 10;
const WAIT_VERCEL = "waiting: Vercel didn't say which deployment is live";
const MIN_LEFT_MS = 15_000;

type Row = {
  id: string; repoId: string; appId: string | null; proposalId: string | null; number: number; branch: string; baseBranch: string; headSha: string;
  title: string; packages: string[]; auto: boolean; stage: PrStage; smokeMode: "http" | "logs" | null; previewReadyAt: Date | null; openedAt: Date;
  fullName: string; appName: string | null;
  // For the allow-list (1.2.1, audit M1): the app's Vercel Root Directory (meta.rootDirectory) and the scan's lockfile.
  meta?: Record<string, unknown> | null; lockfilePath?: string | null;
  // 1.2.2 (D15, review minor 3): the app still watched and not gone (left out in older callers: treated as watched).
  appMonitored?: boolean | null; appGone?: Date | null;
  // The stage text the last round saved (fix round 4: whether it already waited for Vercel).
  stageText?: string | null;
};

export type WatchDeps = {
  rows: () => Promise<Row[]>;
  security: typeof readAutoSecurity;
  rollback: typeof readAutoRollback;
  writeToken: () => Promise<string | null>;
  readToken: (appId: string) => Promise<string | null>;
  vercel: (appId: string) => Promise<{ token: string; teamId: string; projectId: string } | null>;
  monitorUrls: (appId: string) => Promise<string[]>;
  pull: typeof pullState;
  checks: typeof commitChecks;
  runs: typeof runsForCommit;
  previews: typeof deploymentsForCommit;
  probe: (url: string) => Promise<{ status: number | null; ms: number; authWall: boolean }>;
  errorLogs: (v: { token: string; teamId: string; projectId: string }, deploymentId: string, since: Date, now: Date) => Promise<number | null>;
  merge: typeof mergeWatchpostPull;
  // What the allow-list checks before a merge (null: GitHub couldn't be read; the PR waits for the next round).
  review: (token: string, row: Row) => Promise<MergeReview | null>;
  save: (id: string, set: Partial<typeof dependencyPrs.$inferInsert>, proposalId: string | null, stageText: string) => Promise<void>;
  notify: (n: DepPrNotice) => Promise<void>;
  audit: (message: string, appId: string | null) => Promise<void>;
  lockfileBusy?: (repoId: string, branch: string, fullName: string) => Promise<boolean>;
  // 1.2.2 (D15 fix round 2): what the app's live production deployment was built from, read from Vercel now (null: the
  // read failed; source null: the deployment names no source).
  liveSource: (appId: string) => Promise<{ source: ProductionSource | null } | null>;
  book: () => Promise<{ app: { name: string; alias: string; id: string }[]; db: { id: string; name: string; alias: string }[] }>;
};

async function probe(url: string): Promise<{ status: number | null; ms: number; authWall: boolean }> {
  const t = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS), cache: "no-store", headers: { "User-Agent": "Watchbell smoke test" } });
    const body = res.status === 401 || res.status === 403 ? (await res.text().catch(() => "")).slice(0, 8192) : "";
    return { status: res.status, ms: Date.now() - t, authWall: isAuthWall(res.status, body, res.headers) };
  } catch {
    return { status: null, ms: Date.now() - t, authWall: false };
  }
}

// A lockfile job of the VM runner (the private edition's registry, r1) for this PR branch is still queued or running.
// Without a registered runner (the open source edition) there is none. The registry is read lazily: its blocks import
// this file. Never throws.
export async function runnerLockfileActive(repoId: string, branch: string): Promise<boolean> {
  const { extensions } = await import("@/lib/extensions");
  return (await extensions.runner?.lockfileJobActive(repoId, branch).catch(() => false)) ?? false;
}

// The paths the update PR may change (deps-pr.ts: <rootDirectory>/package.json and the scan's lockfile, else the
// folder's package-lock.json), the PR's files and commits, and the files of each commit that isn't the token's own.
// The token's login is read once per instance.
let ownLogin: { token: string; login: string } | null = null;
export async function reviewPr(token: string, row: Row): Promise<MergeReview | null> {
  const dir = cleanRootDir(row.meta?.rootDirectory);
  const manifest = inDir(dir, "package.json");
  const lockfile = row.lockfilePath ?? inDir(dir, "package-lock.json");
  if (ownLogin?.token !== token) {
    const me = await tokenLogin(token);
    if (!me.ok) return null;
    ownLogin = { token, login: me.data };
  }
  const login = ownLogin.login;
  const [files, list] = await Promise.all([pullFiles(token, row.fullName, row.number), pullCommits(token, row.fullName, row.number)]);
  if (!files.ok || !list.ok) return null;
  const commits: PrCommit[] = [];
  for (const c of list.data.slice(0, MAX_REVIEW_COMMITS + 1)) {
    const mine = c.login !== null && c.login.toLowerCase() === login.toLowerCase();
    const changed = mine ? null : await commitFiles(token, row.fullName, c.sha);
    if (changed && !changed.ok) return null;
    commits.push({ ...c, files: changed ? changed.data : null });
  }
  // Review I4: what package.json says at the base and at the head the checks were read at.
  const [before, after] = await Promise.all([
    manifestAt(token, row.fullName, row.baseBranch, {}, manifest), manifestAt(token, row.fullName, row.headSha, {}, manifest),
  ]);
  if (!before.ok || !after.ok) return null;
  const manifestProblem = before.data && after.data ? manifestChangeProblem(before.data.text, after.data.text, row.packages) : "unexpected change: package.json is missing";
  // Review T2b-fix I-1: the lockfile too, when the PR changes it (only npm's can be checked; another kind waits for the owner).
  let lockfileProblem: string | null = null;
  if (lockfile !== manifest && files.data.some((f) => f.filename === lockfile || f.previous === lockfile)) {
    if (!isNpmLockfilePath(lockfile)) lockfileProblem = `unexpected lockfile change ${lockfile} (only package-lock.json can be checked)`;
    else {
      const [lockBefore, lockAfter] = await Promise.all([
        lockfileAt(token, row.fullName, row.baseBranch, lockfile), lockfileAt(token, row.fullName, row.headSha, lockfile),
      ]);
      if (!lockBefore.ok || !lockAfter.ok) return null;
      lockfileProblem = lockfileChangeProblem(lockBefore.data, lockAfter.data, lockfile);
    }
  }
  return { manifest, lockfile, lockfileRequired: !!row.lockfilePath, manifestProblem, lockfileProblem, headSha: row.headSha, tokenLogin: login, files: files.data, commits };
}

// 1.2.2 (D15 fix round 2): the project's current production deployment (the one Vercel serves) and its source, read live
// right before a merge or a "ready to merge" stop: two GETs, only then. Fix round 3: when the latest production build
// failed, the deployment still served (two more GETs); its branch origin (a CLI deploy redeployed or promoted) counts.
// Null when Vercel can't be read, serves nothing, or a production build is still on its way.
// Fix round 4 (re-review r3 I1 and minor 1): the fallback only when the latest production build failed or was canceled
// and none is running. A build that is queued, initializing or building is about to go live (a CLI deploy in progress):
// null, so the PR waits for it. After a succeeded promote, the newest READY production deployment created after it, else
// the promote's target (the newest READY one before it isn't served any more).
export async function liveProductionSource(
  appId: string,
  o: {
    vercel?: WatchDeps["vercel"]; serving?: typeof productionServing; deployment?: typeof getDeployment; ready?: typeof productionDeployments;
    running?: typeof runningProductionBuild;
  } = {},
): Promise<{ source: ProductionSource | null } | null> {
  const v = await (o.vercel ?? DEPS.vercel)(appId);
  if (!v) return null;
  const s = await (o.serving ?? productionServing)(v.token, v.teamId, v.projectId);
  if (!s.ok) return null;
  let id = s.data.currentId;
  let dep: VercelDeployment | null = null;
  if (!id) {
    const state = s.data.latest?.readyState ?? null;
    if (state !== "ERROR" && state !== "CANCELED") return null;
    const running = await (o.running ?? runningProductionBuild)(v.token, v.teamId, v.projectId);
    if (!running.ok || running.data) return null;
    const list = await (o.ready ?? productionDeployments)(v.token, v.teamId, v.projectId);
    if (!list.ok) return null;
    const newest = [...list.data].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const p = s.data.promote;
    if (!p) dep = newest[0] ?? null;
    else {
      dep = newest.find((d) => d.createdAt.getTime() > p.requestedAt) ?? null;
      if (!dep) id = p.toDeploymentId;
    }
  }
  if (!dep && id) {
    const one = await (o.deployment ?? getDeployment)(v.token, { id: v.teamId, slug: v.teamId, name: v.teamId }, id);
    if (!one.ok) return null;
    dep = one.data;
  }
  if (!dep) return null;
  return { source: productionSourceOf({ source: dep.source, branch: dep.branch, sha: dep.sha, branchFrom: dep.branchFrom ?? null, gitDirty: dep.gitDirty === true }) };
}

const DEPS: WatchDeps = {
  rows: async () => (await db().select({
    id: dependencyPrs.id, repoId: dependencyPrs.repoId, appId: dependencyPrs.appId, proposalId: dependencyPrs.proposalId, number: dependencyPrs.number,
    branch: dependencyPrs.branch, baseBranch: dependencyPrs.baseBranch, headSha: dependencyPrs.headSha, title: dependencyPrs.title, packages: dependencyPrs.packages,
    auto: dependencyPrs.auto, stage: dependencyPrs.stage, smokeMode: dependencyPrs.smokeMode, previewReadyAt: dependencyPrs.previewReadyAt, openedAt: dependencyPrs.openedAt,
    fullName: githubRepos.fullName, appName: resources.name, meta: resources.meta, lockfilePath: dependencyScans.lockfilePath,
    appMonitored: resources.monitored, appGone: resources.goneAt, stageText: dependencyPrs.stageText,
  }).from(dependencyPrs).innerJoin(githubRepos, eq(githubRepos.id, dependencyPrs.repoId)).leftJoin(resources, eq(resources.id, dependencyPrs.appId))
    .leftJoin(dependencyScans, eq(dependencyScans.repoId, dependencyPrs.repoId))
    .where(inArray(dependencyPrs.stage, [...OPEN_STAGES])).orderBy(asc(dependencyPrs.openedAt)).limit(MAX_PRS)) as Row[],
  security: readAutoSecurity,
  rollback: readAutoRollback,
  writeToken: async () => { const a = await writeAccount(); return a && a !== "unreadable" ? a.token : null; },
  readToken: async (appId) => { const a = await repoReadAccess(appId); return a.ok ? a.token : null; },
  vercel: async (appId) => {
    const t = await loadTarget(appId, "app");
    const teamId = t?.resource.meta.teamId;
    return t && typeof teamId === "string" && t.resource.externalId ? { token: t.token, teamId, projectId: t.resource.externalId } : null;
  },
  monitorUrls: async (appId) => (await db().select({ url: monitors.url }).from(monitors)
    .where(and(eq(monitors.resourceId, appId), eq(monitors.kind, "http"))).limit(10)).map((m) => m.url),
  pull: pullState, checks: commitChecks, runs: runsForCommit, previews: deploymentsForCommit, probe,
  errorLogs: async (v, deploymentId, since, now) => {
    const r = await readRequestLogs(v.token, v.teamId, v.projectId, { since, until: now, now, deploymentId, levels: ["error", "fatal"], maxRows: 20, timeoutMs: 8_000 });
    return r.ok ? r.lines.length : null;
  },
  merge: mergeWatchpostPull,
  review: reviewPr,
  save: async (id, set, proposalId, stageText) => {
    await db().update(dependencyPrs).set({ ...set, stageText, checkedAt: new Date() }).where(eq(dependencyPrs.id, id));
    if (proposalId) await db().update(actionProposals).set({ result: stageText }).where(eq(actionProposals.id, proposalId)).catch(() => undefined);
  },
  notify: (n) => notifyDepPr(n),
  liveSource: (appId) => liveProductionSource(appId),
  lockfileBusy: async (repoId, branch, fullName) => (await runnerLockfileActive(repoId, branch)) || (await actionsLockfilePending(fullName, branch)),
  audit: (message, appId) => recordAction({ kind: "ok", message, resourceId: appId, actorUserId: null }),
  book: () => readAliasBook(),
};

export type WatchRound = { watched: number; merged: number; stopped: number };

export async function watchDepPrs(now: Date, deadline: number, deps: WatchDeps = DEPS): Promise<WatchRound> {
  const out: WatchRound = { watched: 0, merged: 0, stopped: 0 };
  const left = () => deadline - Date.now();
  const rows = await deps.rows();
  if (!rows.length) return out;
  const [security, rollback, token] = await Promise.all([deps.security().catch(() => null), deps.rollback().catch(() => null), deps.writeToken().catch(() => null)]);
  if (!token) return out;
  const book = await deps.book().catch(() => EMPTY_BOOK);
  for (const row of rows) {
    if (left() < MIN_LEFT_MS) break;
    if (!row.auto && !security?.enabled) continue;
    try {
      const step = await oneRound(row, now, token, rollback?.enabled === true, deps);
      if (!step) continue;
      out.watched++;
      const app = row.appName ? appAlias(book as never, row.appName) : "app";
      await apply(row, step, app, rollback?.windowMin ?? 30, now, token, deps, out);
    } catch (e) {
      console.warn("deps/watch failed:", e instanceof Error ? e.name : "error");
    }
  }
  return out;
}

type Seen = { step: WatchStep; smoke: SmokeVerdict | null; previewReadyAt: Date | null; headSha: string };

async function oneRound(row: Row, now: Date, token: string, rollbackOn: boolean, d: WatchDeps): Promise<Seen | null> {
  const pr = await d.pull(token, row.fullName, row.number);
  if (!pr.ok) return null;
  let checks = await d.checks(token, row.fullName, pr.data.headSha);
  let actionRuns: { status: string; conclusion: string | null }[] | null = null;
  if (checks.ok && checks.data.checkRuns === null && row.appId) {
    const read = await d.readToken(row.appId);
    const runs = read ? await d.runs(read, row.fullName, pr.data.headSha) : null;
    actionRuns = runs?.ok ? runs.data : null;
  }
  if (!checks.ok) checks = { ok: true, data: { checkRuns: [{ status: "queued", conclusion: null }], combined: null } }; // unknown → wait
  const verdict = checksVerdict({ ...checks.data, actionRuns });
  let preview: { state: "ready" | "building" | "error" | "canceled" | null; readyAt: Date | null } = { state: null, readyAt: null };
  let smoke: SmokeVerdict | null = null;
  const v = row.appId ? await d.vercel(row.appId) : null;
  if (v && verdict === "success" && pr.data.headSha === row.headSha) {
    const list = await d.previews(v.token, v.teamId, v.projectId, pr.data.headSha);
    const dep = list.ok ? list.data.find((x) => x.target === "preview") ?? list.data[0] ?? null : null;
    if (dep) {
      preview = { state: dep.state, readyAt: dep.readyAt ?? (dep.state === "ready" ? now : null) };
      if (dep.state === "ready" && dep.url) {
        const readyAt = row.previewReadyAt ?? preview.readyAt ?? now;
        if (row.smokeMode !== "logs") {
          const paths = smokePaths(row.appId ? await d.monitorUrls(row.appId) : []);
          const probes: HttpProbe[] = await Promise.all(paths.map(async (path) => ({ path, ...(await d.probe(`https://${dep.url}${path}`)) })));
          smoke = httpVerdict(probes);
        }
        if (!smoke) smoke = logsVerdict(readyAt, now, await d.errorLogs(v, dep.id, readyAt, now).catch(() => null));
        preview.readyAt = readyAt;
      }
    }
  }
  const step = watchStep({
    now, openedAt: row.openedAt, pr: { state: pr.data.state, merged: pr.data.merged, mergeable: pr.data.mergeable, headSha: pr.data.headSha, base: pr.data.base },
    recordedSha: row.headSha, recordedBase: row.baseBranch, checks: verdict, preview, smoke, autoRollbackOn: rollbackOn,
  });
  return { step, smoke, previewReadyAt: preview.readyAt, headSha: pr.data.headSha };
}

// Why the watcher must not merge this PR itself (null: nothing against it). Exported for the tests.
export function mergeBlock(row: Pick<Row, "appId" | "appMonitored" | "appGone" | "meta" | "baseBranch">, now: Date): string | null {
  if (!row.appId || row.appMonitored === false || row.appGone) {
    return "the app is gone or no longer watched, so Watchbell can't confirm what production is built from. Merging this PR could replace what is live";
  }
  const mismatch = productionMismatch(row.meta?.productionSource, row.baseBranch, now);
  if (mismatch) return mismatch;
  // Fix round 1b (coordinator): production was promoted from a preview of the PR's base, which isn't the Vercel project's
  // production branch. Merging there builds a preview only; the owner promotes it.
  const src = readProductionSource(row.meta?.productionSource);
  const prodBranch = row.meta?.productionBranch;
  if (src?.kind === "git" && src.ref === row.baseBranch && typeof prodBranch === "string" && prodBranch !== row.baseBranch) {
    return `Merging into ${row.baseBranch} won't deploy to production by itself: production was promoted from a ${row.baseBranch} preview. Merge, then promote the new preview.`;
  }
  return null;
}

async function apply(row: Row, seen: Seen, app: string, windowMin: number, now: Date, token: string, d: WatchDeps, out: WatchRound): Promise<void> {
  const { step } = seen;
  const smokeSet = seen.smoke ? { smokeMode: seen.smoke.mode } : {};
  const ready = seen.previewReadyAt ? { previewReadyAt: seen.previewReadyAt } : {};
  const n = { app, number: row.number, packages: row.packages };
  if (step.kind === "wait") {
    await d.save(row.id, { stage: step.stage, ...smokeSet, ...ready, ...(step.resetSha ? { headSha: step.resetSha, previewReadyAt: null, smokeMode: null } : {}) }, row.proposalId, stageLine(row.number, step.stage, step.reason));
    return;
  }
  if (step.kind === "done") {
    await d.save(row.id, { stage: step.stage, finishedAt: now }, row.proposalId, stageLine(row.number, step.stage));
    return;
  }
  if (step.kind === "stop" && (step.reason === "CI gagal" || step.reason === "CI failed") && // pr-watch.ts wording: Indonesian or English
     (await d.lockfileBusy?.(row.repoId, row.branch, row.fullName).catch(() => false))) {
    // The VM runner is still updating the lockfile; its commit moves the head and the checks start again.
    await d.save(row.id, { stage: "checks" }, row.proposalId, stageLine(row.number, "checks", "waiting for the lockfile from the runner"));
    return;
  }
  // Watchbell 1.2.2 (D15, incident 25 Oct): never merged automatically, and never announced as "ready to merge" (also
  // with auto-rollback off, fix round 2), when production wasn't built from the PR's base (a CLI deploy, another branch),
  // when that can't be confirmed lately, when the app is gone or no longer watched (its source isn't read any more), or
  // when production was only promoted from the base (1b). "Needs a look" with the reason; the PR stays open for the owner.
  const stopBlocked = async (blocked: string) => {
    await d.save(row.id, { stage: "failed", finishedAt: now, ...smokeSet }, row.proposalId, stageLine(row.number, "failed", blocked));
    out.stopped++;
    await d.notify({ ...n, kind: "stopped", reason: blocked.replace(/\.$/, "") }).catch(() => undefined);
  };
  const blocked = step.kind === "merge" || (step.kind === "stop" && step.stage === "ready-manual") ? mergeBlock(row, now) : null;
  if (blocked) return stopBlocked(blocked);
  // Fix rounds 2 and 3: one live read of what production is built from right now, checked like the stored one, right
  // before a merge and before a "ready to merge (manual)" stop. It covers a source never recorded, and a CLI deploy since
  // the collector's last read. A failed read: nothing merged or announced; the stage says Vercel didn't answer and the
  // next round tries again, until WATCH_TIMEOUT_MS after the preview was ready: needs a look. A deployment that names no
  // source can't be confirmed: needs a look. True: handled (the caller stops here).
  const liveGate = async (): Promise<boolean> => {
    const live = row.appId ? await d.liveSource(row.appId).catch(() => null) : null;
    if (!live) {
      // The 45 minutes count from the preview's ready time (no column keeps the first failed read: that needs a
      // migration), and fix round 4: never on the first failed read, only when the previous round already waited for
      // Vercel (its stage text says so), so one transient failure can't stop a PR.
      const since = seen.previewReadyAt ?? row.previewReadyAt ?? row.openedAt;
      const waitedBefore = (row.stageText ?? "").includes(WAIT_VERCEL);
      if (waitedBefore && now.getTime() - since.getTime() > WATCH_TIMEOUT_MS) {
        await stopBlocked("Vercel didn't say which deployment is live for 45 minutes, so Watchbell can't confirm what production is built from. Check it, then merge yourself");
        return true;
      }
      const stage: PrStage = row.stage === "checks" || row.stage === "preview" || row.stage === "smoke" ? row.stage : "smoke";
      await d.save(row.id, { stage, ...smokeSet, ...ready }, row.proposalId, stageLine(row.number, stage, WAIT_VERCEL));
      return true;
    }
    const fresh = live.source ? mergeBlock({ ...row, meta: { ...(row.meta ?? {}), productionSource: { ...live.source, at: now.toISOString() } } }, now)
      : `Watchbell can't confirm what production is built from (Vercel names no branch for it). Merging this PR could deploy ${row.baseBranch} to production and replace what is live.`;
    if (fresh) {
      await stopBlocked(fresh);
      return true;
    }
    return false;
  };
  if (step.kind === "stop" && step.stage === "ready-manual" && (await liveGate())) return;
  if (step.kind === "stop") {
    await d.save(row.id, { stage: step.stage, finishedAt: now, ...smokeSet }, row.proposalId, stageLine(row.number, step.stage, step.stage === "ready-manual" ? null : step.reason));
    out.stopped++;
    await d.notify({ ...n, kind: step.stage === "ready-manual" ? "ready-manual" : "stopped", reason: step.reason }).catch(() => undefined);
    return;
  }
  // The allow-list (1.2.1, audit M1): only package.json and its lockfile, only Watchbell's own commits.
  const review = await d.review(token, row).catch(() => null);
  if (!review) return; // GitHub couldn't be read: the next round tries again
  const unexpected = unexpectedChange(review);
  if (!unexpected && lockfileMissing(review) && now.getTime() - row.openedAt.getTime() > WATCH_TIMEOUT_MS) {
    const reason = "the lockfile wasn't added within 45 minutes";
    await d.save(row.id, { stage: "timeout", finishedAt: now, ...smokeSet }, row.proposalId, stageLine(row.number, "timeout", reason));
    out.stopped++;
    await d.notify({ ...n, kind: "stopped", reason }).catch(() => undefined);
    return;
  }
  if (!unexpected && lockfileMissing(review)) {
    await d.save(row.id, { stage: "checks" }, row.proposalId, stageLine(row.number, "checks", "waiting for the lockfile"));
    return;
  }
  if (unexpected) {
    await d.save(row.id, { stage: "failed", finishedAt: now, ...smokeSet }, row.proposalId, stageLine(row.number, "failed", unexpected));
    out.stopped++;
    await d.notify({ ...n, kind: "stopped", reason: unexpected }).catch(() => undefined);
    return;
  }
  if (await liveGate()) return;
  // Merge: the head must still be the one the checks were read at (GitHub refuses otherwise too).
  await d.save(row.id, { stage: "merging", ...smokeSet, ...ready }, row.proposalId, stageLine(row.number, "merging"));
  const r = await d.merge(token, row.fullName, row.number, row.branch, row.baseBranch, row.headSha, row.title);
  if (r.ok) {
    await d.save(row.id, { stage: "merged", mergedSha: r.data.sha, finishedAt: now }, row.proposalId, stageLine(row.number, "merged"));
    out.merged++;
    await d.audit(`${AUTO_AUDIT_PREFIX}PR #${row.number} merged · ${row.packages.join(", ")}`.slice(0, 200), row.appId).catch(() => undefined);
    await d.notify({ ...n, kind: "merged", windowMin }).catch(() => undefined);
    return;
  }
  if (r.status === 409) {
    // The head moved between the read and the merge: check again next round.
    await d.save(row.id, { stage: "checks" }, row.proposalId, stageLine(row.number, "checks", "new commit on the PR branch, checking again"));
    return;
  }
  const reason = r.status === 405 ? "GitHub refused the merge (cannot be merged)" : `merge failed: ${r.error}`.slice(0, 150);
  await d.save(row.id, { stage: "failed", finishedAt: now }, row.proposalId, stageLine(row.number, "failed", reason));
  out.stopped++;
  await d.notify({ ...n, kind: "stopped", reason }).catch(() => undefined);
}

// The minute step (minuteSteps): every 2 minutes per instance; never throws. Watchbell 1.2: paused while the DevOps
// section is off (Manage › Sections); the watch picks up where it was once it is on again.
let lastWatch: number | null = null;
export function resetDepWatch(): void {
  lastWatch = null;
}
export async function depPrMinuteStep(now: Date, ctx?: { deadline?: number }, paused: () => Promise<Set<SectionId>> = pausedSections): Promise<void> {
  if (!watchDue(now, lastWatch)) return;
  if ((await paused()).has("devops")) return;
  lastWatch = now.getTime();
  try {
    const r = await watchDepPrs(now, ctx?.deadline ?? now.getTime() + 50_000);
    if (r.watched) console.log(`deps/watch: ${r.watched} PR, ${r.merged} merged, ${r.stopped} stopped`);
  } catch (e) {
    console.warn("deps/watch failed:", e instanceof Error ? e.name : "error");
  }
}
