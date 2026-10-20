import "server-only";
import type { ActionResult } from "@/lib/action";
import { type Actor, finish, type Finisher, loadTarget, type Target, targetQuota } from "@/lib/data/provider-action-db";
import { type ActionOutcome, scopeMessage, STALE, type WriteFailure } from "@/lib/provider-actions";
import { currentProduction, productionDeployments, redeploy, rollback, runningProductionBuild, type VercelDeployment, type VercelFailure, type VercelWriteFailure } from "@/lib/providers/vercel";
import { deployRole } from "@/lib/view/deploy-actions";

// Stage 6 Vercel writes, the shared server half (Stage 9 moved it out of vercel-actions.ts): the console buttons
// ("use server", which check the role first) and an approved office proposal (proposals-run.ts) run the same guards:
// quota, the live state at Vercel, then the one write, audited by `fin` (finish, or finish without a page refresh).

export const DPL = /^dpl_[A-Za-z0-9]{8,40}$/;
export const GONE = "This app or its Vercel credential isn't available any more. Reload the page.";
export const LIVE = "Already live.";
export const HOBBY = "Hobby can only roll back to the previous production deployment.";
export const ROLLED_BACK = "Rolled back: promote a deployment first. A redeploy would stay staged and not go live.";
export const NOT_STAGED = "Only a ready production deployment newer than the live one can be promoted.";
export const RUNNING = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
export const NOT_PREVIEW = "Only a ready preview of this app can be promoted to production.";
export const PREVIEW_ROLLED_BACK = "Rolled back: promote a production deployment first. A promoted preview would stay staged and not go live.";
export const GONE_DEPLOYMENT = "Vercel can't find that deployment any more. Reload and try again.";

export type Ctx = { member: Actor; t: Target; appId: string; app: string; teamId: string; teamSlug: string; projectId: string };
export type Live = { name: string; currentId: string | null; production: VercelDeployment[] };

export const refuse = (message: string): ActionOutcome => ({ done: false, message });
export const ref = (d: VercelDeployment | undefined, id: string) => (d?.sha ? d.sha.slice(0, 7) : id);

// Quota first (A4), then the app, its team and its opened credential.
export async function prepare(member: Actor, action: string, appId: string): Promise<Ctx | string> {
  const quota = await targetQuota(member.id, action, appId);
  if (quota) return quota;
  const t = await loadTarget(appId, "app");
  const teamId = t?.resource.meta.teamId;
  if (!t || typeof teamId !== "string" || !teamId || !t.resource.externalId) return GONE;
  const slug = t.resource.meta.teamSlug;
  return { member, t, appId, app: t.resource.name, teamId, teamSlug: typeof slug === "string" ? slug : "", projectId: t.resource.externalId };
}

// The deployment Vercel serves now (its own answer, else the newest READY production one, as the collector decides)
// and the newest READY production deployments around it.
export async function live(c: Ctx): Promise<{ ok: true; data: Live } | VercelFailure> {
  const [cur, list] = await Promise.all([
    currentProduction(c.t.token, c.teamId, c.projectId),
    productionDeployments(c.t.token, c.teamId, c.projectId),
  ]);
  if (!cur.ok) return cur;
  if (!list.ok) return list;
  return { ok: true, data: { name: cur.data.name, currentId: cur.data.currentId ?? list.data[0]?.id ?? null, production: list.data } };
}

// A6: a 403 on a write is one sentence about the token's team scope; Vercel's body never reaches the UI or the audit.
export function failure(r: VercelWriteFailure, c: Ctx): WriteFailure {
  if (r.kind === "scope") return { ok: false, kind: "scope", status: r.status, error: scopeMessage("vercel", { team: c.teamSlug }) };
  if (r.status === 404) return { ok: false, kind: "missing", status: 404, error: "Vercel can't find that deployment any more. Reload and try again." };
  return { ok: false, kind: r.kind === "auth" ? "auth" : r.kind === "format" ? "format" : "transient", ...(r.status ? { status: r.status } : {}), error: r.error };
}

export async function write(c: Ctx, r: { ok: true } | VercelWriteFailure, done: { message: string; audit: string }, failed: string, fin: Finisher = finish): Promise<ActionResult> {
  const outcome: ActionOutcome = r.ok
    ? { done: true, message: done.message, audit: { message: done.audit, resourceId: c.appId } }
    : { done: false, failed: failure(r, c), audit: { message: failed, resourceId: c.appId } };
  return fin(outcome, c.member, c.t.account.id);
}

// The caller has checked the ids (redeployAction: the role and the shapes; proposals-run: the stored target).
// Redeploy the current production deployment: same commit, today's environment variables. `expectedCurrentId` is the
// deployment the dialog showed; a different one live now means the page is stale.
export async function redeployAs(member: Actor, appId: string, expectedCurrentId: string, fin: Finisher = finish): Promise<ActionResult> {
  {
    const c = await prepare(member, "redeploy", appId);
    if (typeof c === "string") return fin(refuse(c), member, "");
    const l = await live(c);
    if (!l.ok) return fin(refuse(l.error), member, c.t.account.id);
    if (l.data.currentId !== expectedCurrentId) return fin(refuse(STALE), member, c.t.account.id);
    // A9: while rolled back, Vercel keeps new production builds staged, so a redeploy wouldn't go live and would only
    // spend one of Hobby's 100 deployments a day.
    if (l.data.production.some((d) => deployRole(d, l.data.currentId, l.data.production) === "staged")) {
      return fin(refuse(ROLLED_BACK), member, c.t.account.id);
    }
    const running = await runningProductionBuild(c.t.token, c.teamId, c.projectId);
    if (!running.ok) return fin(refuse(running.error), member, c.t.account.id);
    if (running.data) return fin(refuse(`A production build of ${c.app} is already running.`), member, c.t.account.id);
    const sha = ref(l.data.production.find((d) => d.id === expectedCurrentId), expectedCurrentId);
    const r = await redeploy(c.t.token, c.teamId, { projectId: c.projectId, name: l.data.name, deploymentId: expectedCurrentId });
    return write(c, r, { message: `Redeploy requested. Vercel is building ${c.app} again.`, audit: `Redeploy requested · ${c.app} · ${sha}` }, `Redeploy failed · ${c.app} · ${sha}`, fin);
  }
}

// Roll back to the previous production deployment, the only one Hobby allows.
export async function rollbackAs(member: Actor, appId: string, targetId: string, fin: Finisher = finish): Promise<ActionResult> {
  {
    const c = await prepare(member, "rollback", appId);
    if (typeof c === "string") return fin(refuse(c), member, "");
    const l = await live(c);
    if (!l.ok) return fin(refuse(l.error), member, c.t.account.id);
    if (l.data.currentId === targetId) return fin(refuse(LIVE), member, c.t.account.id);
    const target = l.data.production.find((d) => d.id === targetId);
    if (!target || deployRole(target, l.data.currentId, l.data.production) !== "previous") return fin(refuse(HOBBY), member, c.t.account.id);
    const sha = ref(target, targetId);
    const r = await rollback(c.t.token, c.teamId, c.projectId, targetId);
    return write(c, r, {
      message: `Rolled back ${c.app} to ${sha}. New pushes don't go live until you promote one.`, audit: `Rolled back · ${c.app} → ${sha}`,
    }, `Roll back failed · ${c.app} → ${sha}`, fin);
  }
}

