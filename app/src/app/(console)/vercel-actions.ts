"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { currentDeploymentId, deploymentOfApp, deploymentState } from "@/lib/data/deployments-db";
import { finish, loadTarget } from "@/lib/data/provider-action-db";
import { releaseNotesFor } from "@/lib/data/release-notes-db";
import { DPL, GONE, GONE_DEPLOYMENT, LIVE, live, NOT_PREVIEW, NOT_STAGED, prepare, PREVIEW_ROLLED_BACK, redeployAs, ref, refuse, rollbackAs, RUNNING, write } from "@/lib/data/vercel-action";
import { extensions } from "@/lib/extensions";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";
import { cancelDeployment, getDeployment, promote, promotePreview, runningProductionBuild } from "@/lib/providers/vercel";
import { buildLogs } from "@/lib/providers/vercel-build-logs";
import { type BuildLog, DEMO_BUILD_EXPLAIN, DEMO_BUILD_LOG } from "@/lib/view/build-logs";
import { deployRole } from "@/lib/view/deploy-actions";
import { DEMO_RELEASE_NOTES, type ReleaseNotes } from "@/lib/view/release-notes";

// Stage 6 (spec §12, plan A1–A6): the console's Vercel writes. Each one is a public endpoint, so each re-checks the role
// (Operator+), the ids, the member quota and the per-target cooldown, then reads the live state at Vercel and only writes
// when that state still allows it. Refusals and no-ops make no provider call and aren't audited (finish answers them).

const deps = { requireActionMember };

// Redeploy the current production deployment: same commit, today's environment variables. `expectedCurrentId` is the
// deployment the dialog showed; a different one live now means the page is stale. The guards are in redeployAs.
export async function redeployAction(appId: string, expectedCurrentId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId) || typeof expectedCurrentId !== "string" || !DPL.test(expectedCurrentId)) return { ok: false, error: INVALID };
    return redeployAs(member, appId, expectedCurrentId);
  }, deps);
}

// 1.2.1 (4c): Applications → row menu → Redeploy. The list carries no deployment ids, so the console's current
// production deployment is the one the dialog meant; redeployAs then checks it against Vercel's live state as above.
export async function redeployCurrentAction(appId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const current = await currentDeploymentId(appId);
    if (!current) return { ok: false, error: "No current production deployment" };
    return redeployAs(member, appId, current);
  }, deps);
}

// Task 4 (owner 24 Oct): a deployment's build log for the drawer. Operator+ (viewers don't get the button and are
// refused here); only a deployment of this watched app; read with the app's team id and the stored token on the server,
// newest build, last 2,000 lines, not cached. A read, so no quota and no audit. Demo: a canned log, no provider call.
export async function buildLogsAction(appId: string, deploymentId: string): Promise<ActionResult<BuildLog>> {
  return runGuarded<BuildLog>("operator", async () => {
    if (!isUuid(appId) || typeof deploymentId !== "string" || !DPL.test(deploymentId)) return { ok: false, error: INVALID };
    if (!(await deploymentOfApp(appId, deploymentId))) return { ok: false, error: INVALID };
    const t = await loadTarget(appId, "app");
    const teamId = t?.resource.meta.teamId;
    if (!t || typeof teamId !== "string" || !teamId) return { ok: false, error: GONE };
    const r = await buildLogs(t.token, teamId, deploymentId);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: `Couldn't read the build log: ${r.error}` };
  }, deps, async () => ({ ok: true, data: DEMO_BUILD_LOG }));
}

// Watchbell 1.3 Explain with AI: a failed build's log, read now, handed to the AI extension's explainBuild (which cuts
// secrets out, checks the shared AI quota and asks the owner's provider once). Owner only, like Ask AI. Nothing is stored.
// Demo: a canned explanation, no provider call.
// Builds being explained right now (member + deployment): a second click, or the drawer reopened mid-request, would
// spend the AI quota twice. Per server instance, which is where a quick repeat lands.
const explaining = new Set<string>();

export async function explainBuildAction(appId: string, deploymentId: string): Promise<ActionResult<{ text: string; model: string }>> {
  return runGuarded<{ text: string; model: string }>("owner", async (member) => {
    if (!isUuid(appId) || typeof deploymentId !== "string" || !DPL.test(deploymentId)) return { ok: false, error: INVALID };
    const explain = extensions.explainBuild;
    if (!explain) return { ok: false, error: "Explain with AI needs the AI gateway." };
    const state = await deploymentState(appId, deploymentId);
    if (!state) return { ok: false, error: INVALID };
    if (state !== "error") return { ok: false, error: "Only a failed build can be explained." };
    const t = await loadTarget(appId, "app");
    const teamId = t?.resource.meta.teamId;
    if (!t || typeof teamId !== "string" || !teamId) return { ok: false, error: GONE };
    const log = await buildLogs(t.token, teamId, deploymentId);
    if (!log.ok) return { ok: false, error: `Couldn't read the build log: ${log.error}` };
    const key = `${member.id}:${deploymentId}`;
    if (explaining.has(key)) return { ok: false, error: "That build is already being explained. Try again in a moment." };
    explaining.add(key);
    try {
      const r = await explain({ app: t.resource.name, lines: log.data.lines, memberId: member.id });
      return r.ok ? { ok: true, data: { text: r.text, model: r.model } } : { ok: false, error: r.error };
    } finally {
      explaining.delete(key);
    }
  }, deps, async () => ({ ok: true, data: DEMO_BUILD_EXPLAIN }));
}

// Watchbell 1.3 What changed: the commits between this production deployment and the one before it, from GitHub's
// compare. Operator+, on demand only; a read, so no quota and no audit. Demo: made-up commits, no provider call.
export async function releaseNotesAction(appId: string, deploymentId: string): Promise<ActionResult<ReleaseNotes>> {
  return runGuarded<ReleaseNotes>("operator", async () => {
    if (!isUuid(appId) || typeof deploymentId !== "string" || !DPL.test(deploymentId)) return { ok: false, error: INVALID };
    const r = await releaseNotesFor(appId, deploymentId);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, deps, async () => ({ ok: true, data: DEMO_RELEASE_NOTES }));
}

// Roll back to the previous production deployment, the only one Hobby allows (guards in rollbackAs).
export async function rollbackAction(appId: string, targetId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId) || typeof targetId !== "string" || !DPL.test(targetId)) return { ok: false, error: INVALID };
    return rollbackAs(member, appId, targetId);
  }, deps);
}

// Promote a staged production deployment (a READY one newer than the live one, which a roll back leaves). Previews go
// through promotePreviewAction instead, because promoting one rebuilds it.
export async function promoteAction(appId: string, targetId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId) || typeof targetId !== "string" || !DPL.test(targetId)) return { ok: false, error: INVALID };
    const c = await prepare(member, "promote", appId);
    if (typeof c === "string") return finish(refuse(c), member, "");
    const l = await live(c);
    if (!l.ok) return finish(refuse(l.error), member, c.t.account.id);
    if (l.data.currentId === targetId) return finish(refuse(LIVE), member, c.t.account.id);
    const target = l.data.production.find((d) => d.id === targetId);
    if (!target || deployRole(target, l.data.currentId, l.data.production) !== "staged") return finish(refuse(NOT_STAGED), member, c.t.account.id);
    const sha = ref(target, targetId);
    const r = await promote(c.t.token, c.teamId, c.projectId, targetId);
    return write(c, r, { message: `Promoted ${sha}. New pushes to ${c.app} go live again.`, audit: `Promoted · ${c.app} → ${sha}` }, `Promote failed · ${c.app} → ${sha}`);
  }, deps);
}

// Cancel a queued or running build of this app. The deployment must belong to the app's project.
export async function cancelAction(appId: string, deploymentId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId) || typeof deploymentId !== "string" || !DPL.test(deploymentId)) return { ok: false, error: INVALID };
    const c = await prepare(member, "cancel", appId);
    if (typeof c === "string") return finish(refuse(c), member, "");
    const d = await getDeployment(c.t.token, { id: c.teamId, slug: c.teamSlug, name: c.teamSlug }, deploymentId);
    if (!d.ok) return finish(refuse(d.status === 404 ? "Vercel can't find that build any more." : d.error), member, c.t.account.id);
    if (d.data.projectId !== c.projectId) return finish(refuse(INVALID), member, c.t.account.id);
    if (!RUNNING.has(d.data.rawState)) return finish(refuse("This build already finished."), member, c.t.account.id);
    const sha = ref(d.data, deploymentId);
    const r = await cancelDeployment(c.t.token, c.teamId, deploymentId);
    return write(c, r, { message: "Build canceled. The current production deployment stays live.", audit: `Build canceled · ${c.app} · ${sha}` }, `Cancel failed · ${c.app} · ${sha}`);
  }, deps);
}

// Slice 2 (B1): promote a READY preview of this app to production. Vercel builds the preview's source again as a new
// production deployment with the production environment variables (the endpoint is Redeploy's, as `vercel promote`
// does it), so the same guards apply: not while rolled back (the build would stay staged) and not while a production
// build is already running. Hobby allows it; it counts toward the 100 deployments a day.
export async function promotePreviewAction(appId: string, previewId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(appId) || typeof previewId !== "string" || !DPL.test(previewId)) return { ok: false, error: INVALID };
    const c = await prepare(member, "promote-preview", appId);
    if (typeof c === "string") return finish(refuse(c), member, "");
    const d = await getDeployment(c.t.token, { id: c.teamId, slug: c.teamSlug, name: c.teamSlug }, previewId);
    if (!d.ok) return finish(refuse(d.status === 404 ? GONE_DEPLOYMENT : d.error), member, c.t.account.id);
    if (d.data.projectId !== c.projectId) return finish(refuse(INVALID), member, c.t.account.id);
    if (d.data.target !== "preview" || d.data.rawState !== "READY") return finish(refuse(NOT_PREVIEW), member, c.t.account.id);
    const l = await live(c);
    if (!l.ok) return finish(refuse(l.error), member, c.t.account.id);
    if (l.data.production.some((p) => deployRole(p, l.data.currentId, l.data.production) === "staged")) {
      return finish(refuse(PREVIEW_ROLLED_BACK), member, c.t.account.id);
    }
    const running = await runningProductionBuild(c.t.token, c.teamId, c.projectId);
    if (!running.ok) return finish(refuse(running.error), member, c.t.account.id);
    if (running.data) return finish(refuse(`A production build of ${c.app} is already running.`), member, c.t.account.id);
    const sha = ref(d.data, previewId);
    const r = await promotePreview(c.t.token, c.teamId, { projectId: c.projectId, name: l.data.name, deploymentId: previewId });
    return write(c, r, {
      message: `Promoting ${sha} to production. Vercel is building ${c.app} with the production environment variables; it goes live when the build is ready.`,
      audit: `Preview promoted · ${c.app} · ${sha}`,
    }, `Preview promote failed · ${c.app} · ${sha}`);
  }, deps);
}
