import { isUuid } from "@/lib/ids";

// Watchbell 1.2.1 (owner 23 Oct: "security check every 6 h and after each deploy"). Pure. When the Vercel task records a
// new current production deployment for a watched app, the app is marked (ops.settings "security.afterDeploy", no schema
// change); the next collector `security` run checks the marked apps first, even before its 6-hourly slot. Each part of
// a mark (the Next.js check, the dependency scan) is done once; a check that ran out of time is an attempt, and the mark
// settles when both parts are done or after MAX_ATTEMPTS, so a deployment is checked at most once. `checked` remembers the last deployment
// checked per app, so the same deployment is never marked again.

export const AFTER_DEPLOY_SETTING = "security.afterDeploy";
// A mark not settled within this time is dropped: the 6-hourly run covers the app anyway, and a mark that can never be
// settled must not make every minute run start the security task.
export const AFTER_DEPLOY_TTL_MS = 6 * 3_600_000;
export const CHECKED_MAX = 500;
// Fix round 1 (review important 2): a check that started and ran out of time counts as an attempt; after this many the
// mark is settled (the 6-hourly run and the daily job, with more time, cover the app).
export const MAX_ATTEMPTS = 3;

// next / deps: that part (the Next.js check, the dependency scan) is done for this deployment, so it isn't repeated.
export type Mark = { id: string; at: string; attempts: number; next?: true; deps?: true };
export type AfterDeploy = { pending: Record<string, Mark>; checked: Record<string, string> };
export type DeployMark = { appId: string; deploymentId: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100;

export function parseAfterDeploy(raw: unknown): AfterDeploy {
  const out: AfterDeploy = { pending: {}, checked: {} };
  if (!isObj(raw)) return out;
  if (isObj(raw.pending)) {
    for (const [app, m] of Object.entries(raw.pending)) {
      if (!isUuid(app) || !isObj(m) || !isId(m.id) || typeof m.at !== "string" || Number.isNaN(Date.parse(m.at))) continue;
      const attempts = typeof m.attempts === "number" && Number.isInteger(m.attempts) && m.attempts >= 0 ? Math.min(m.attempts, MAX_ATTEMPTS) : 0;
      out.pending[app] = { id: m.id, at: m.at, attempts, ...(m.next === true ? { next: true as const } : {}), ...(m.deps === true ? { deps: true as const } : {}) };
    }
  }
  if (isObj(raw.checked)) for (const [app, id] of Object.entries(raw.checked)) if (isUuid(app) && isId(id)) out.checked[app] = id;
  return out;
}

export const pendingApps = (s: AfterDeploy): string[] => Object.keys(s.pending);
export const hasPending = (s: AfterDeploy): boolean => pendingApps(s).length > 0;

// New marks: an app whose deployment was already checked, or is already waiting, is left as it is; a newer deployment
// replaces a waiting one (a burst of deploys gets one check, of the latest).
export function markDeploys(s: AfterDeploy, marks: readonly DeployMark[], now: Date): { state: AfterDeploy; changed: boolean } {
  const next: AfterDeploy = { pending: { ...s.pending }, checked: { ...s.checked } };
  let changed = false;
  for (const m of marks) {
    if (!isUuid(m.appId) || !isId(m.deploymentId)) continue;
    if (next.checked[m.appId] === m.deploymentId || next.pending[m.appId]?.id === m.deploymentId) continue;
    next.pending[m.appId] = { id: m.deploymentId, at: now.toISOString(), attempts: 0 };
    changed = true;
  }
  return { state: next, changed };
}

const capChecked = (checked: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(checked);
  return entries.length <= CHECKED_MAX ? checked : Object.fromEntries(entries.slice(entries.length - CHECKED_MAX));
};

// The marks of these apps are done: their deployment moves to `checked` (most recent last, at most CHECKED_MAX).
export function settleMarks(s: AfterDeploy, appIds: readonly string[]): AfterDeploy {
  const pending = { ...s.pending };
  const checked = { ...s.checked };
  for (const app of appIds) {
    const m = pending[app];
    if (!m) continue;
    delete pending[app];
    delete checked[app];
    checked[app] = m.id;
  }
  return { pending, checked: capChecked(checked) };
}

// Marks older than the TTL are settled without a check.
export function expireMarks(s: AfterDeploy, now: Date): AfterDeploy {
  const old = Object.entries(s.pending).filter(([, m]) => now.getTime() - Date.parse(m.at) > AFTER_DEPLOY_TTL_MS).map(([app]) => app);
  return old.length ? settleMarks(s, old) : s;
}

// The marked apps whose `part` isn't done yet.
export const marksNeeding = (s: AfterDeploy, part: "next" | "deps"): string[] => Object.entries(s.pending).filter(([, m]) => !m[part]).map(([app]) => app);

// One security run's outcome for the marks. nextDone: apps whose Next.js check finished, failed, or has nothing to check;
// nextStarted: apps whose check began (one that ran out of time is an attempt); depsDone: apps whose repository was tried
// or has nothing to scan. A paused part (hosting / devops false) isn't waited for. Finished or exhausted marks settle.
export type RunOutcome = {
  hosting: boolean; devops: boolean; nextDone?: ReadonlySet<string>; nextStarted?: ReadonlySet<string>; depsDone?: ReadonlySet<string>;
};
export function recordRun(s: AfterDeploy, r: RunOutcome): AfterDeploy {
  const pending: Record<string, Mark> = {};
  const finished: string[] = [];
  for (const [app, m0] of Object.entries(s.pending)) {
    const m: Mark = { ...m0 };
    if (r.hosting && !m.next) {
      if (r.nextDone?.has(app)) m.next = true;
      else if (r.nextStarted?.has(app)) m.attempts = Math.min(m.attempts + 1, MAX_ATTEMPTS);
    }
    if (r.devops && !m.deps && r.depsDone?.has(app)) m.deps = true;
    pending[app] = m;
    if (((m.next || !r.hosting) && (m.deps || !r.devops)) || m.attempts >= MAX_ATTEMPTS) finished.push(app);
  }
  return settleMarks({ pending, checked: s.checked }, finished);
}

// The Vercel task: the deployment to mark for an app, or null. A deployment that just became current (the flag update
// changed its row: a deploy, a promote or a rollback), or (fix round 1, review minor 2) a current one created within the
// TTL that is neither waiting nor checked, so a mark whose write failed is made again on the next run. Never one that is
// already waiting or checked.
export function deployToMark(o: { appId: string; currentId: string | null; changedIds: readonly string[]; createdAt: Date | null; state: AfterDeploy; now: Date }): string | null {
  const id = o.currentId;
  if (!id || o.state.checked[o.appId] === id || o.state.pending[o.appId]?.id === id) return null;
  if (newCurrent(o.changedIds, id)) return id;
  return o.createdAt && o.now.getTime() - o.createdAt.getTime() <= AFTER_DEPLOY_TTL_MS ? id : null;
}

// The Vercel task's flag update returns the rows whose current/previous flags changed. The current deployment is among
// them only when it wasn't current before: a new current production deployment (a deploy, a promote or a rollback).
export function newCurrent(changedIds: readonly string[], currentId: string | null): string | null {
  return currentId && changedIds.includes(currentId) ? currentId : null;
}
