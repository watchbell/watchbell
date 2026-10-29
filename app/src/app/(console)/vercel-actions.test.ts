import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import { INVALID, scopeMessage, STALE } from "@/lib/provider-actions";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const ACCOUNT = "223e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(),
  loadTarget: vi.fn(),
  targetQuota: vi.fn(),
  finish: vi.fn(),
  currentProduction: vi.fn(),
  productionDeployments: vi.fn(),
  runningProductionBuild: vi.fn(),
  getDeployment: vi.fn(),
  redeploy: vi.fn(),
  rollback: vi.fn(),
  promote: vi.fn(),
  cancelDeployment: vi.fn(),
  promotePreview: vi.fn(),
  currentDeploymentId: vi.fn(),
  deploymentOfApp: vi.fn(),
  buildLogs: vi.fn(),
  deploymentState: vi.fn(),
  ext: {} as { explainBuild?: ReturnType<typeof vi.fn> },
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/provider-action-db", () => ({ loadTarget: h.loadTarget, targetQuota: h.targetQuota, finish: h.finish }));
vi.mock("@/lib/providers/vercel", () => ({
  currentProduction: h.currentProduction, productionDeployments: h.productionDeployments, runningProductionBuild: h.runningProductionBuild,
  getDeployment: h.getDeployment, redeploy: h.redeploy, rollback: h.rollback, promote: h.promote, cancelDeployment: h.cancelDeployment,
  promotePreview: h.promotePreview,
}));

vi.mock("@/lib/data/deployments-db", () => ({ currentDeploymentId: h.currentDeploymentId, deploymentOfApp: h.deploymentOfApp, deploymentState: h.deploymentState }));
vi.mock("@/lib/extensions", () => ({ extensions: h.ext }));
vi.mock("@/lib/providers/vercel-build-logs", () => ({ buildLogs: h.buildLogs }));

import { DEMO_BUILD_LOG, DEMO_BUILD_EXPLAIN } from "@/lib/view/build-logs";
import { buildLogsAction, cancelAction, explainBuildAction, promoteAction, promotePreviewAction, redeployAction, redeployCurrentAction, rollbackAction } from "./vercel-actions";

const at = (hh: number) => new Date(Date.UTC(2026, 9, 13, hh));
const dep = (id: string, hh: number, extra: Record<string, unknown> = {}) => ({
  id, projectId: "prj_web", state: "ready", rawState: "READY", target: "production", branch: "main", sha: `${id.slice(4, 8)}abc1234`, message: null,
  source: "git", url: null, createdAt: at(hh), buildingAt: null, readyAt: null, ...extra,
});
const CUR = "dpl_cur00000001";
const PREV = "dpl_prv00000001";
const OLD = "dpl_old00000001";
const STAGED = "dpl_stg00000001";
const BUILD = "dpl_bld00000001";
const PREVIEW = "dpl_pvw00000001";
const readyPreview = () => dep(PREVIEW, 6, { target: "preview", branch: "feature/x" });
const notRolledBack = () => h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(CUR, 4), dep(PREV, 3), dep(OLD, 2)] });
const target = {
  resource: { id: APP, name: "portfolio-site", externalId: "prj_web", meta: { teamId: "team_a", teamSlug: "acme-team" } },
  account: { id: ACCOUNT, label: "acme", provider: "vercel", scopeNote: null },
  token: "tok_secret",
};
const writes = () => [h.redeploy, h.rollback, h.promote, h.cancelDeployment, h.promotePreview];

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.targetQuota.mockResolvedValue(null);
  h.loadTarget.mockResolvedValue(target);
  // The real finish audits and records access; here it only answers like it does.
  h.finish.mockImplementation(async (o: { message?: string; failed?: { error: string }; audit?: unknown }) => (
    !o.audit ? { ok: false, error: o.message } : o.failed ? { ok: false, error: o.failed.error } : { ok: true, message: o.message }
  ));
  h.currentProduction.mockResolvedValue({ ok: true, data: { name: "portfolio-site", currentId: CUR } });
  // Live READY production: a staged one (after a roll back), the current, the previous and an older one.
  h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(STAGED, 5), dep(CUR, 4), dep(PREV, 3), dep(OLD, 2)] });
  h.runningProductionBuild.mockResolvedValue({ ok: true, data: null });
  h.getDeployment.mockResolvedValue({ ok: true, data: dep(BUILD, 6, { state: "building", rawState: "BUILDING" }) });
  h.redeploy.mockResolvedValue({ ok: true, data: { id: "dpl_new00000001" } });
  h.promotePreview.mockResolvedValue({ ok: true, data: { id: "dpl_new00000002" } });
  for (const w of [h.rollback, h.promote, h.cancelDeployment]) w.mockResolvedValue({ ok: true, data: null });
});

const all = [
  ["redeployAction", () => { h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(CUR, 4), dep(PREV, 3)] }); return redeployAction(APP, CUR); }, () => redeployAction(APP, "nope"), "redeploy"],
  ["rollbackAction", () => rollbackAction(APP, PREV), () => rollbackAction("nope", PREV), "rollback"],
  ["promoteAction", () => promoteAction(APP, STAGED), () => promoteAction(APP, "dpl_x"), "promote"],
  ["cancelAction", () => cancelAction(APP, BUILD), () => cancelAction(APP, "dpl_../../x"), "cancel"],
  ["promotePreviewAction", () => { notRolledBack(); h.getDeployment.mockResolvedValue({ ok: true, data: readyPreview() }); return promotePreviewAction(APP, PREVIEW); }, () => promotePreviewAction(APP, "x"), "promote-preview"],
] as const;

describe.each(all)("%s", (_name, call, bad, action) => {
  it("needs an operator: a viewer is refused before any quota, load or provider call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await call()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.loadTarget).not.toHaveBeenCalled();
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before the quota", async () => {
    expect(await bad()).toEqual({ ok: false, error: INVALID });
    expect(h.targetQuota).not.toHaveBeenCalled();
  });

  it("passes the quota's message through, with no provider call", async () => {
    h.targetQuota.mockResolvedValue("That was just done. Wait a minute before trying again.");
    expect(await call()).toEqual({ ok: false, error: "That was just done. Wait a minute before trying again." });
    expect(h.targetQuota).toHaveBeenCalledWith("mem-1", action, APP);
    expect(h.loadTarget).not.toHaveBeenCalled();
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
  });

  it("refuses an app that is gone or has no team, with no provider call", async () => {
    h.loadTarget.mockResolvedValue(null);
    expect((await call()).ok).toBe(false);
    h.loadTarget.mockResolvedValue({ ...target, resource: { ...target.resource, meta: {} } });
    expect((await call()).ok).toBe(false);
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
    expect(h.currentProduction).not.toHaveBeenCalled();
  });

  it("a 403 on the write answers the scope sentence and is handed to finish as a scope failure", async () => {
    const denied = { ok: false, kind: "scope", status: 403, error: "Vercel refused this token for that project (403)." };
    for (const w of [h.rollback, h.promote, h.cancelDeployment, h.redeploy, h.promotePreview]) w.mockResolvedValue(denied);
    const sentence = scopeMessage("vercel", { team: "acme-team" });
    expect(await call()).toEqual({ ok: false, error: sentence });
    const [outcome, who, accountId] = h.finish.mock.calls[0];
    expect(outcome).toMatchObject({ done: false, failed: { kind: "scope", error: sentence }, audit: { resourceId: APP } });
    expect(who).toBe(member);
    expect(accountId).toBe(ACCOUNT);
  });
});

describe("redeployAction", () => {
  // Not rolled back: no staged deployment above the live one.
  beforeEach(() => h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(CUR, 4), dep(PREV, 3), dep(OLD, 2)] }));

  it("refuses while rolled back (a staged deployment waits): the new build wouldn't go live", async () => {
    h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(STAGED, 5), dep(CUR, 4), dep(PREV, 3)] });
    expect(await redeployAction(APP, CUR)).toEqual({ ok: false, error: "Rolled back: promote a deployment first. A redeploy would stay staged and not go live." });
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("refuses with STALE when the live current deployment isn't the one the dialog showed", async () => {
    h.currentProduction.mockResolvedValue({ ok: true, data: { name: "portfolio-site", currentId: STAGED } });
    expect(await redeployAction(APP, CUR)).toEqual({ ok: false, error: STALE });
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("refuses while a production build is already running", async () => {
    h.runningProductionBuild.mockResolvedValue({ ok: true, data: dep(BUILD, 6, { state: "building" }) });
    expect(await redeployAction(APP, CUR)).toEqual({ ok: false, error: "A production build of portfolio-site is already running." });
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("a failed live read is answered without a write", async () => {
    h.currentProduction.mockResolvedValue({ ok: false, kind: "transient", error: "Couldn't reach Vercel." });
    expect(await redeployAction(APP, CUR)).toEqual({ ok: false, error: "Couldn't reach Vercel." });
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("falls back to the newest READY production deployment when Vercel names no current one", async () => {
    h.currentProduction.mockResolvedValue({ ok: true, data: { name: "portfolio-site", currentId: null } });
    h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(CUR, 4), dep(PREV, 3)] });
    expect((await redeployAction(APP, CUR)).ok).toBe(true);
  });

  it("redeploys the current production deployment and audits it", async () => {
    const r = await redeployAction(APP, CUR);
    expect(r.ok).toBe(true);
    expect(h.redeploy).toHaveBeenCalledWith("tok_secret", "team_a", { projectId: "prj_web", name: "portfolio-site", deploymentId: CUR });
    expect(h.finish).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, audit: { message: "Redeploy requested · portfolio-site · cur0abc", resourceId: APP } }), member, ACCOUNT,
    );
  });
});

// 1.2.1 (4c): Applications → row menu → Redeploy. The list has no deployment ids, so the action takes the console's
// current production deployment and runs the app page's redeploy with it (live check, roll-back and running guards).
describe("redeployCurrentAction", () => {
  beforeEach(() => {
    notRolledBack();
    h.currentDeploymentId.mockResolvedValue(CUR);
  });

  it("redeploys the console's current production deployment through the same guards", async () => {
    const r = await redeployCurrentAction(APP);
    expect(r.ok).toBe(true);
    expect(h.currentDeploymentId).toHaveBeenCalledWith(APP);
    expect(h.redeploy).toHaveBeenCalledWith("tok_secret", "team_a", { projectId: "prj_web", name: "portfolio-site", deploymentId: CUR });
  });

  it("refuses while rolled back, like the app page", async () => {
    h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(STAGED, 5), dep(CUR, 4), dep(PREV, 3)] });
    expect(await redeployCurrentAction(APP)).toEqual({ ok: false, error: "Rolled back: promote a deployment first. A redeploy would stay staged and not go live." });
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("no current production deployment known: a plain refusal, no Vercel call", async () => {
    h.currentDeploymentId.mockResolvedValue(null);
    expect(await redeployCurrentAction(APP)).toEqual({ ok: false, error: "No current production deployment" });
    expect(h.currentProduction).not.toHaveBeenCalled();
    expect(h.redeploy).not.toHaveBeenCalled();
  });

  it("checks the role and the id first", async () => {
    expect(await redeployCurrentAction("nope")).toEqual({ ok: false, error: INVALID });
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await redeployCurrentAction(APP)).ok).toBe(false);
    expect(h.redeploy).not.toHaveBeenCalled();
  });
});

// Task 4 build logs: read server-side with the app's team id and stored token; Operator+ only; demo shows a canned log.
describe("buildLogsAction", () => {
  const log = { lines: [{ at: 1, kind: "stdout", text: "> next build" }], truncated: false };
  beforeEach(() => {
    h.deploymentOfApp.mockResolvedValue(true);
    h.buildLogs.mockResolvedValue({ ok: true, data: log });
  });

  it("reads the build events with the app's team id and the stored token", async () => {
    expect(await buildLogsAction(APP, BUILD)).toEqual({ ok: true, data: log });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.deploymentOfApp).toHaveBeenCalledWith(APP, BUILD);
    expect(h.loadTarget).toHaveBeenCalledWith(APP, "app");
    expect(h.buildLogs).toHaveBeenCalledWith("tok_secret", "team_a", BUILD);
  });

  it("viewers are refused before any read (the role gate)", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await buildLogsAction(APP, BUILD)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.loadTarget).not.toHaveBeenCalled();
    expect(h.buildLogs).not.toHaveBeenCalled();
  });

  it("only a deployment of this app, with valid ids", async () => {
    expect(await buildLogsAction("nope", BUILD)).toEqual({ ok: false, error: INVALID });
    expect(await buildLogsAction(APP, "dpl_x")).toEqual({ ok: false, error: INVALID });
    h.deploymentOfApp.mockResolvedValue(false);
    expect(await buildLogsAction(APP, BUILD)).toEqual({ ok: false, error: INVALID });
    expect(h.buildLogs).not.toHaveBeenCalled();
  });

  it("a failed read is one sentence, never Vercel's body", async () => {
    h.buildLogs.mockResolvedValue({ ok: false, kind: "auth", status: 403, error: "Vercel rejected this credential (403)." });
    expect(await buildLogsAction(APP, BUILD)).toEqual({ ok: false, error: "Couldn't read the build log: Vercel rejected this credential (403)." });
    h.loadTarget.mockResolvedValue(null);
    expect((await buildLogsAction(APP, BUILD)).ok).toBe(false);
  });

  it("demo mode shows the canned log and calls nothing", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    try {
      expect(await buildLogsAction(APP, BUILD)).toEqual({ ok: true, data: DEMO_BUILD_LOG });
      expect(h.loadTarget).not.toHaveBeenCalled();
      expect(h.buildLogs).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// Watchbell 1.3: Explain with AI, owner only, a failed build only, through the AI extension's explainBuild slot.
describe("explainBuildAction", () => {
  const owner = { ...member, role: "owner" as const };
  const log = { lines: [{ at: 1, kind: "stderr", text: "Type error: nope" }], truncated: false };
  beforeEach(() => {
    h.requireActionMember.mockResolvedValue(owner);
    h.deploymentState.mockResolvedValue("error");
    h.buildLogs.mockResolvedValue({ ok: true, data: log });
    h.ext.explainBuild = vi.fn(async () => ({ ok: true, text: "The type is wrong.", model: "groq/llama" }));
  });

  it("reads the failed build's log and hands it to the slot with the app's name and the member", async () => {
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: true, data: { text: "The type is wrong.", model: "groq/llama" } });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.deploymentState).toHaveBeenCalledWith(APP, BUILD);
    expect(h.buildLogs).toHaveBeenCalledWith("tok_secret", "team_a", BUILD);
    expect(h.ext.explainBuild).toHaveBeenCalledWith({ app: "portfolio-site", lines: log.lines, memberId: owner.id });
  });

  it("an Operator is refused before any read", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.buildLogs).not.toHaveBeenCalled();
  });

  it("only a failed build of this app, with valid ids", async () => {
    expect(await explainBuildAction("nope", BUILD)).toEqual({ ok: false, error: INVALID });
    h.deploymentState.mockResolvedValue(null);
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: INVALID });
    h.deploymentState.mockResolvedValue("ready");
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: "Only a failed build can be explained." });
    expect(h.buildLogs).not.toHaveBeenCalled();
    expect(h.ext.explainBuild).not.toHaveBeenCalled();
  });

  it("without the AI extension: says the gateway is needed", async () => {
    delete h.ext.explainBuild;
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: "Explain with AI needs the AI gateway." });
    expect(h.buildLogs).not.toHaveBeenCalled();
  });

  it("a failed log read or a slot refusal is passed on as one sentence", async () => {
    h.buildLogs.mockResolvedValue({ ok: false, kind: "auth", status: 403, error: "Vercel rejected this credential (403)." });
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: "Couldn't read the build log: Vercel rejected this credential (403)." });
    h.buildLogs.mockResolvedValue({ ok: true, data: log });
    h.ext.explainBuild!.mockResolvedValue({ ok: false, error: "There is too little in the build log to explain." });
    expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: false, error: "There is too little in the build log to explain." });
  });

  it("demo mode answers the canned explanation and calls nothing", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    try {
      expect(await explainBuildAction(APP, BUILD)).toEqual({ ok: true, data: DEMO_BUILD_EXPLAIN });
      expect(h.buildLogs).not.toHaveBeenCalled();
      expect(h.ext.explainBuild).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("rollbackAction", () => {
  it("refuses a deployment that isn't the previous one (Hobby), with no write", async () => {
    expect(await rollbackAction(APP, OLD)).toEqual({ ok: false, error: "Hobby can only roll back to the previous production deployment." });
    expect(await rollbackAction(APP, "dpl_unknown0001")).toEqual({ ok: false, error: "Hobby can only roll back to the previous production deployment." });
    expect(h.rollback).not.toHaveBeenCalled();
  });

  it("answers Already live for the current one", async () => {
    expect(await rollbackAction(APP, CUR)).toEqual({ ok: false, error: "Already live." });
    expect(h.rollback).not.toHaveBeenCalled();
  });

  it("rolls back to the previous production deployment and audits it", async () => {
    expect((await rollbackAction(APP, PREV)).ok).toBe(true);
    expect(h.rollback).toHaveBeenCalledWith("tok_secret", "team_a", "prj_web", PREV);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ done: true, audit: { message: "Rolled back · portfolio-site → prv0abc", resourceId: APP } });
  });
});

describe("promoteAction", () => {
  it("answers Already live for the current deployment, with no write", async () => {
    expect(await promoteAction(APP, CUR)).toEqual({ ok: false, error: "Already live." });
    expect(h.promote).not.toHaveBeenCalled();
  });

  it("refuses a deployment that isn't staged (older production, preview or unknown)", async () => {
    for (const id of [PREV, OLD, "dpl_preview0001"]) expect((await promoteAction(APP, id)).ok).toBe(false);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it("promotes a staged production deployment and audits it", async () => {
    expect((await promoteAction(APP, STAGED)).ok).toBe(true);
    expect(h.promote).toHaveBeenCalledWith("tok_secret", "team_a", "prj_web", STAGED);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ done: true, audit: { message: "Promoted · portfolio-site → stg0abc", resourceId: APP } });
  });
});

describe("cancelAction", () => {
  it("answers that a READY deployment already finished, with no write", async () => {
    h.getDeployment.mockResolvedValue({ ok: true, data: dep(BUILD, 6) });
    expect(await cancelAction(APP, BUILD)).toEqual({ ok: false, error: "This build already finished." });
    expect(h.cancelDeployment).not.toHaveBeenCalled();
  });

  it("refuses a deployment of another project", async () => {
    h.getDeployment.mockResolvedValue({ ok: true, data: dep(BUILD, 6, { state: "building", rawState: "BUILDING", projectId: "prj_other" }) });
    expect(await cancelAction(APP, BUILD)).toEqual({ ok: false, error: INVALID });
    expect(h.cancelDeployment).not.toHaveBeenCalled();
  });

  it("cancels a running build and audits it", async () => {
    expect((await cancelAction(APP, BUILD)).ok).toBe(true);
    expect(h.getDeployment).toHaveBeenCalledWith("tok_secret", expect.objectContaining({ id: "team_a" }), BUILD);
    expect(h.cancelDeployment).toHaveBeenCalledWith("tok_secret", "team_a", BUILD);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ done: true, audit: { message: "Build canceled · portfolio-site · bld0abc", resourceId: APP } });
  });
});

// Slice 2 (B1): a ready preview, built again for production with the production environment variables.
describe("promotePreviewAction", () => {
  beforeEach(() => {
    notRolledBack();
    h.getDeployment.mockResolvedValue({ ok: true, data: readyPreview() });
  });

  it("refuses a deployment of another project", async () => {
    h.getDeployment.mockResolvedValue({ ok: true, data: { ...readyPreview(), projectId: "prj_other" } });
    expect(await promotePreviewAction(APP, PREVIEW)).toEqual({ ok: false, error: INVALID });
    expect(h.promotePreview).not.toHaveBeenCalled();
  });

  it("refuses anything but a READY preview (a production deployment, a building or failed preview)", async () => {
    for (const d of [dep(PREVIEW, 6), dep(PREVIEW, 6, { target: "preview", state: "building", rawState: "BUILDING" }), dep(PREVIEW, 6, { target: "preview", state: "error", rawState: "ERROR" })]) {
      h.getDeployment.mockResolvedValue({ ok: true, data: d });
      expect(await promotePreviewAction(APP, PREVIEW)).toEqual({ ok: false, error: "Only a ready preview of this app can be promoted to production." });
    }
    expect(h.promotePreview).not.toHaveBeenCalled();
  });

  it("a preview Vercel no longer has is refused", async () => {
    h.getDeployment.mockResolvedValue({ ok: false, kind: "transient", status: 404, error: "Vercel returned an error (404)." });
    expect(await promotePreviewAction(APP, PREVIEW)).toEqual({ ok: false, error: "Vercel can't find that deployment any more. Reload and try again." });
    expect(h.promotePreview).not.toHaveBeenCalled();
  });

  it("refuses while rolled back: the new production build would stay staged", async () => {
    h.productionDeployments.mockResolvedValue({ ok: true, data: [dep(STAGED, 5), dep(CUR, 4), dep(PREV, 3)] });
    expect(await promotePreviewAction(APP, PREVIEW)).toEqual({ ok: false, error: expect.stringContaining("Rolled back") });
    expect(h.promotePreview).not.toHaveBeenCalled();
  });

  it("refuses while a production build is already running", async () => {
    h.runningProductionBuild.mockResolvedValue({ ok: true, data: dep(BUILD, 6, { state: "building", rawState: "BUILDING" }) });
    expect(await promotePreviewAction(APP, PREVIEW)).toEqual({ ok: false, error: "A production build of portfolio-site is already running." });
    expect(h.promotePreview).not.toHaveBeenCalled();
  });

  it("promotes the preview with the project's live name and audits it", async () => {
    const r = await promotePreviewAction(APP, PREVIEW);
    expect(r).toEqual({ ok: true, message: expect.stringContaining("production environment variables") });
    expect(h.promotePreview).toHaveBeenCalledWith("tok_secret", "team_a", { projectId: "prj_web", name: "portfolio-site", deploymentId: PREVIEW });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ done: true, audit: { message: "Preview promoted · portfolio-site · pvw0abc", resourceId: APP } });
  });
});
