import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { dependencyPrs, githubRepos, monitors, resources } from "@/db/schema";
import { readAliasBook } from "@/lib/data/aliases-db";
import { recordAction } from "@/lib/data/audit-db";
import { pausedSections } from "@/lib/data/sections-db";
import type { SectionId } from "@/lib/sections";
import { actionsLockfilePending } from "@/lib/data/actions-lockfile-db";
import { writeAccount } from "@/lib/data/deps-pr";
import { repoReadAccess } from "@/lib/data/github-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import {
  checksVerdict, type HttpProbe, httpVerdict, isAuthWall, logsVerdict, OPEN_STAGES, type PrStage, SMOKE_TIMEOUT_MS, smokePaths, type SmokeVerdict,
  stageLine, watchDue, type WatchStep, watchStep,
} from "@/lib/deps/pr-watch";
import { runsForCommit } from "@/lib/providers/github";
import { commitChecks, mergeWatchpostPull, pullState } from "@/lib/providers/github-write";
import { deploymentsForCommit } from "@/lib/providers/vercel";
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
const MIN_LEFT_MS = 15_000;

type Row = {
  id: string; repoId: string; appId: string | null; proposalId: string | null; number: number; branch: string; baseBranch: string; headSha: string;
  title: string; packages: string[]; auto: boolean; stage: PrStage; smokeMode: "http" | "logs" | null; previewReadyAt: Date | null; openedAt: Date;
  fullName: string; appName: string | null;
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
  save: (id: string, set: Partial<typeof dependencyPrs.$inferInsert>, proposalId: string | null, stageText: string) => Promise<void>;
  notify: (n: DepPrNotice) => Promise<void>;
  audit: (message: string, appId: string | null) => Promise<void>;
  lockfileBusy?: (repoId: string, branch: string, fullName: string) => Promise<boolean>;
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

const DEPS: WatchDeps = {
  rows: async () => (await db().select({
    id: dependencyPrs.id, repoId: dependencyPrs.repoId, appId: dependencyPrs.appId, proposalId: dependencyPrs.proposalId, number: dependencyPrs.number,
    branch: dependencyPrs.branch, baseBranch: dependencyPrs.baseBranch, headSha: dependencyPrs.headSha, title: dependencyPrs.title, packages: dependencyPrs.packages,
    auto: dependencyPrs.auto, stage: dependencyPrs.stage, smokeMode: dependencyPrs.smokeMode, previewReadyAt: dependencyPrs.previewReadyAt, openedAt: dependencyPrs.openedAt,
    fullName: githubRepos.fullName, appName: resources.name,
  }).from(dependencyPrs).innerJoin(githubRepos, eq(githubRepos.id, dependencyPrs.repoId)).leftJoin(resources, eq(resources.id, dependencyPrs.appId))
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
  save: async (id, set, proposalId, stageText) => {
    await db().update(dependencyPrs).set({ ...set, stageText, checkedAt: new Date() }).where(eq(dependencyPrs.id, id));
    if (proposalId) await db().update(actionProposals).set({ result: stageText }).where(eq(actionProposals.id, proposalId)).catch(() => undefined);
  },
  notify: (n) => notifyDepPr(n),
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
    now, openedAt: row.openedAt, pr: { state: pr.data.state, merged: pr.data.merged, mergeable: pr.data.mergeable, headSha: pr.data.headSha },
    recordedSha: row.headSha, checks: verdict, preview, smoke, autoRollbackOn: rollbackOn,
  });
  return { step, smoke, previewReadyAt: preview.readyAt, headSha: pr.data.headSha };
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
  if (step.kind === "stop") {
    await d.save(row.id, { stage: step.stage, finishedAt: now, ...smokeSet }, row.proposalId, stageLine(row.number, step.stage, step.stage === "ready-manual" ? null : step.reason));
    out.stopped++;
    await d.notify({ ...n, kind: step.stage === "ready-manual" ? "ready-manual" : "stopped", reason: step.reason }).catch(() => undefined);
    return;
  }
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
