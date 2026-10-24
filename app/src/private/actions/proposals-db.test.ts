import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, limitOf, payloadOf, whereOf } from "@/lib/data/fake-db";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { actionProposals } from "@/private/db/schema";
import type { ProposalAlert, ProposalDraft } from "./proposals";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./proposals-run", () => ({ runProposalAction: vi.fn() }));

import {
  claimProposal, createProposals, decideProposal, executeProposal, expireProposals, finishProposal, listProposals, pruneProposals, readLogApps, readProposal, runLogProposals,
  runProposalsStep, type StepDeps,
} from "./proposals-db";

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect["sqlToQuery"]>[0]);
const now = new Date("2026-10-15T05:00:00Z");
const ID = "123e4567-e89b-42d3-a456-426614174000";
const ALERT = "523e4567-e89b-42d3-a456-426614174000";
const APP = "623e4567-e89b-42d3-a456-426614174000";
const MON = "723e4567-e89b-42d3-a456-426614174000";
const MEMBER = "823e4567-e89b-42d3-a456-426614174000";

const row = (o: object = {}) => ({
  id: ID, room: "workloads", action: "recheck", risk: "safe", title: "Check app-a again now", reason: "app-a /. Down.", resourceName: "app-a",
  proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: now, decidedAt: null, expiresAt: new Date(now.getTime() + 7_200_000),
  resourceId: APP, targetRef: MON, ...o,
});
const draft = (o: Partial<ProposalDraft> = {}): ProposalDraft => ({
  alertId: ALERT, ruleKey: "MonitorDown", room: "workloads", action: "recheck", risk: "safe", title: "t", reason: "r", resourceKind: "app", resourceId: APP,
  resourceName: "app-a", targetRef: MON, proposedBy: "Workloads officer", expiresAt: new Date(now.getTime() + 7_200_000), ...o,
});

beforeEach(() => { h.current = null; });

describe("createProposals", () => {
  it("skips (alert, action) pairs proposed before, inserts the rest with ON CONFLICT DO NOTHING", async () => {
    const f = fakeDb([[{ alertId: ALERT, action: "recheck" }]], [[row({ action: "neon_wake" })]]);
    h.current = f;
    const out = await createProposals([draft(), draft({ action: "neon_wake", targetRef: "ep-a-1" })]);
    expect(out).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ kind: "insert", table: actionProposals });
    const values = payloadOf(f.writes[0].calls) as unknown as Record<string, unknown>[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ action: "neon_wake", status: "pending" });
    expect(f.writes[0].calls.map((c) => c.method)).toContain("onConflictDoNothing");
  });
  it("writes nothing when every pair exists, or for no drafts", async () => {
    const f = fakeDb([[{ alertId: ALERT, action: "recheck" }]]);
    h.current = f;
    expect(await createProposals([draft()])).toEqual([]);
    expect(await createProposals([])).toEqual([]);
    expect(f.writes).toHaveLength(0);
  });
});

describe("listProposals", () => {
  it("reads the last 7 days, pending first then newest, with the limit, as contract proposals", async () => {
    const f = fakeDb([[row()]]);
    h.current = f;
    const list = await listProposals(now, 20);
    expect(list[0]).toMatchObject({ id: ID, status: "pending", actionLabel: "Check again now", createdAt: now.toISOString() });
    expect(list[0]).not.toHaveProperty("targetRef");
    expect(limitOf(f.queries[0])).toBe(20);
    const order = f.queries[0].find((c) => c.method === "orderBy")!.args.map((a) => render(a).sql).join(" ");
    expect(order).toContain("'pending' then 0 else 1");
    expect(render(whereOf(f.queries[0])!).params).toContain("2026-10-08T05:00:00.000Z");
  });
});

describe("readProposal", () => {
  it("reads one proposal by id as a contract proposal, or null", async () => {
    const f = fakeDb([[row({ status: "done", result: "Checked." })], []]);
    h.current = f;
    expect(await readProposal(ID)).toMatchObject({ id: ID, status: "done", result: "Checked.", actionLabel: "Check again now" });
    expect(limitOf(f.queries[0])).toBe(1);
    expect(render(whereOf(f.queries[0])!).params).toEqual([ID]);
    expect(await readProposal(ID)).toBeNull();
    expect(f.writes).toHaveLength(0);
  });
});

describe("decideProposal", () => {
  it("moves only a pending, unexpired proposal, storing the member id", async () => {
    const f = fakeDb([], [[row({ status: "approved", decidedAt: now })]]);
    h.current = f;
    const d = await decideProposal(ID, "approve", MEMBER, now);
    expect(d.status).toBe("ok");
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ status: "approved", decidedBy: MEMBER, decidedAt: now });
    const where = render(whereOf(f.writes[0].calls)!);
    expect(where.params).toEqual(expect.arrayContaining([ID, "pending", now.toISOString()]));
  });
  it("is a conflict when it isn't pending any more, missing when unknown", async () => {
    h.current = fakeDb([[row({ status: "done" })]], [[]]);
    expect(await decideProposal(ID, "reject", MEMBER, now)).toMatchObject({ status: "conflict", proposal: { status: "done" } });
    h.current = fakeDb([[]], [[]]);
    expect(await decideProposal(ID, "reject", MEMBER, now)).toEqual({ status: "missing" });
  });
});

describe("claim, finish, execute", () => {
  it("claims approved → running once; finishes running → done | failed", async () => {
    const f = fakeDb([], [[row({ status: "running" })], [row({ status: "done", result: "ok" })]]);
    h.current = f;
    expect(await claimProposal(ID, now)).toMatchObject({ status: "running" });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ status: "running", claimedAt: now });
    expect(render(whereOf(f.writes[0].calls)!).params).toEqual(expect.arrayContaining([ID, "approved"]));
    await finishProposal(ID, true, "ok", now);
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ status: "done", result: "ok" });
    expect(render(whereOf(f.writes[1].calls)!).params).toEqual(expect.arrayContaining([ID, "running"]));
  });
  it("runs with the stored target and stores the scrubbed result; does nothing when the claim is lost", async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, error: "That was just done. Wait a minute before trying again." });
    const f = fakeDb([], [[row({ status: "running" })], [row({ status: "failed", result: "That was just done. Wait a minute before trying again." })]]);
    h.current = f;
    const p = await executeProposal(ID, { id: MEMBER, userId: "u1" }, now, { run, book: async () => EMPTY_BOOK });
    expect(run).toHaveBeenCalledWith({ action: "recheck", resourceId: APP, targetRef: MON, proposalId: ID }, { id: MEMBER, userId: "u1" });
    expect(p).toMatchObject({ status: "failed" });
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ status: "failed", result: "That was just done. Wait a minute before trying again." });
    h.current = fakeDb([], [[]]);
    run.mockClear();
    expect(await executeProposal(ID, "auto", now, { run, book: async () => EMPTY_BOOK })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("expireProposals / pruneProposals", () => {
  it("expires pending ones past their time or whose alert stopped firing, and fails stuck runs", async () => {
    const f = fakeDb([], [[{ id: ID }], []]);
    h.current = f;
    expect(await expireProposals([ALERT], now)).toBe(1);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ status: "expired" });
    const w = render(whereOf(f.writes[0].calls)!);
    expect(w.sql).toContain("not in");
    expect(w.params).toEqual(expect.arrayContaining(["pending", ALERT]));
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ status: "failed" });
    expect(render(whereOf(f.writes[1].calls)!).params).toEqual(expect.arrayContaining(["running", "2026-10-15T04:50:00.000Z"]));
  });
  it("prunes closed proposals older than 30 days", async () => {
    const f = fakeDb([]);
    h.current = f;
    await pruneProposals(now);
    expect(f.writes[0]).toMatchObject({ kind: "delete", table: actionProposals });
    expect(render(whereOf(f.writes[0].calls)!).params).toEqual(expect.arrayContaining(["2026-09-15T05:00:00.000Z", "pending", "approved", "running"]));
  });
});

describe("runProposalsStep", () => {
  const alert: ProposalAlert = {
    id: ALERT, ruleKey: "MonitorDown", subject: MON, severity: "critical", title: "shortly /", message: "3 consecutive checks failed.", resourceId: APP,
    resourceKind: "app", resourceName: "shortly", causedBy: null, silencedUntil: null, silencedUntilResolved: false,
  };
  const off = { recheck: false, neon_wake: false, supabase_keepalive: false, supabase_restore: false, vercel_redeploy: false, vercel_rollback: false };
  const deps = (o: Partial<StepDeps> = {}): StepDeps => ({
    firing: vi.fn().mockResolvedValue([alert]), book: vi.fn().mockResolvedValue(EMPTY_BOOK),
    facts: vi.fn().mockResolvedValue({ monitorKinds: new Map([[MON, "http"]]), deploys: new Map(), supabaseRefs: new Map(), neonSuspended: new Map() }),
    create: vi.fn().mockResolvedValue([row()]), expire: vi.fn().mockResolvedValue(0), autoRun: vi.fn().mockResolvedValue(off),
    approveAuto: vi.fn().mockResolvedValue(true), execute: vi.fn().mockResolvedValue({ ...row({ status: "done", auto: true }), id: ID }),
    notifyNew: vi.fn().mockResolvedValue(undefined), notifyResult: vi.fn().mockResolvedValue(undefined), logs: vi.fn().mockResolvedValue({ created: [], expired: 0 }), queueDev: vi.fn().mockResolvedValue(new Set()), ...o,
  });

  it("with nothing firing only expires (no facts, no create)", async () => {
    const d = deps({ firing: vi.fn().mockResolvedValue([]), expire: vi.fn().mockResolvedValue(2) });
    expect(await runProposalsStep(now, {}, d)).toEqual({ created: 0, expired: 2, autoRan: 0 });
    expect(d.expire).toHaveBeenCalledWith([], now);
    expect(d.facts).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });
  it("skips the reads when no firing alert can get a proposal", async () => {
    const d = deps({ firing: vi.fn().mockResolvedValue([{ ...alert, ruleKey: "CertExpiringSoon" }]) });
    await runProposalsStep(now, {}, d);
    expect(d.facts).not.toHaveBeenCalled();
  });
  it("creates proposals and notifies the new ones; auto-run off runs nothing", async () => {
    const d = deps();
    expect(await runProposalsStep(now, {}, d)).toEqual({ created: 1, expired: 0, autoRan: 0 });
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([expect.objectContaining({ action: "recheck", targetRef: MON })]);
    expect(d.approveAuto).not.toHaveBeenCalled();
    expect(d.notifyNew).toHaveBeenCalledWith([expect.objectContaining({ id: ID, status: "pending" })], {}, { devQueued: new Set() });
    expect(d.queueDev).not.toHaveBeenCalled();
  });
  it("auto-runs a safe kind that is switched on, then reports its result instead of a new-proposal notice", async () => {
    const d = deps({ autoRun: vi.fn().mockResolvedValue({ ...off, recheck: true }) });
    expect(await runProposalsStep(now, {}, d)).toEqual({ created: 1, expired: 0, autoRan: 1 });
    expect(d.approveAuto).toHaveBeenCalledWith(ID, expect.any(Date));
    expect(d.execute).toHaveBeenCalledWith(ID, expect.any(Date));
    expect(d.notifyNew).toHaveBeenCalledWith([], {}, { devQueued: new Set() });
    expect(d.notifyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "done", auto: true }));
  });
  // Watchbell 1.2 (D11): a section the owner turned off gets no new proposals; its open ones wait unchanged.
  it("proposes nothing for a paused section's alerts and skips the log check while Hosting is off", async () => {
    const d = deps({ paused: vi.fn().mockResolvedValue(new Set(["hosting"])), expire: vi.fn().mockResolvedValue(0) });
    expect(await runProposalsStep(now, {}, d)).toEqual({ created: 0, expired: 0, autoRan: 0 });
    expect(d.expire).toHaveBeenCalledWith([ALERT], now); // still firing: its pending proposals aren't expired
    expect(d.facts).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
    expect(d.logs).not.toHaveBeenCalled();
    expect(d.notifyNew).not.toHaveBeenCalled();
  });
  it("pauses an account alert by its account's provider (CredentialExpiring)", async () => {
    const cred = { ...alert, id: "cred-1", ruleKey: "CredentialExpiring", subject: "acc-1", resourceId: null, resourceKind: null, accountId: "acc-1" };
    const providers = vi.fn().mockResolvedValue(new Map([["acc-1", "supabase"]]));
    const d = deps({ firing: vi.fn().mockResolvedValue([cred, alert]), paused: vi.fn().mockResolvedValue(new Set(["database"])), providers });
    await runProposalsStep(now, {}, d);
    expect(providers).toHaveBeenCalledWith(["acc-1"]);
    expect(d.expire).toHaveBeenCalledWith(["cred-1", ALERT], now);
    // Only the Hosting alert (MonitorDown) reached the proposal reads.
    expect((d.facts as ReturnType<typeof vi.fn>).mock.calls[0][0].map((a: { id: string }) => a.id)).toEqual([ALERT]);
    const none = deps({ firing: vi.fn().mockResolvedValue([cred]), providers });
    providers.mockClear();
    await runProposalsStep(now, {}, none);
    expect(providers).not.toHaveBeenCalled(); // nothing paused: no provider read
  });
  it("still proposes for the sections that are on", async () => {
    const d = deps({ paused: vi.fn().mockResolvedValue(new Set(["database", "devops"])) });
    expect(await runProposalsStep(now, {}, d)).toMatchObject({ created: 1 });
    expect(d.logs).toHaveBeenCalled();
    const failing = deps({ paused: vi.fn().mockRejectedValue(new Error("db down")) });
    expect(await runProposalsStep(now, {}, failing)).toMatchObject({ created: 1 }); // unreadable: nothing paused
  });
  it("never auto-runs a risky kind, nor with under 8 s left", async () => {
    const d = deps({ create: vi.fn().mockResolvedValue([row({ action: "vercel_redeploy", risk: "risky" })]), autoRun: vi.fn().mockResolvedValue({ ...off, vercel_redeploy: true }) });
    await runProposalsStep(now, {}, d);
    expect(d.approveAuto).not.toHaveBeenCalled();
    const late = deps({ autoRun: vi.fn().mockResolvedValue({ ...off, recheck: true }) });
    await runProposalsStep(now, { deadline: Date.now() + 1000 }, late);
    expect(late.approveAuto).not.toHaveBeenCalled();
  });
  describe("auto-rollback", () => {
    const rb = (o: object = {}) => row({ id: "rb-1", action: "vercel_rollback", risk: "risky", ruleKey: "MonitorDown", resourceId: APP, targetRef: "dpl_prv00000001", reason: "app-a /. Down.", resourceName: "app-a", ...o });
    const ctxApp = (o: object = {}) => ({
      deploy: {
        currentId: "dpl_cur00000001", currentSha: "abcdef1234567", liveAt: new Date(now.getTime() - 10 * 60_000), currentCreatedAt: new Date(now.getTime() - 12 * 60_000),
        newestProdCreatedAt: new Date(now.getTime() - 12 * 60_000), previousId: "dpl_prv00000001", previousState: "ready", previousCreatedAt: new Date(now.getTime() - 86_400_000),
      },
      rolledOrPromotedLately: false, autoLately: false, sameDeployBefore: false, ...o,
    });
    const rbDeps = (o: Partial<StepDeps> = {}, app: object = {}, inFlight = false) => deps({
      firing: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue({ created: [rb()], expired: 0 }),
      autoRollback: vi.fn().mockResolvedValue({ enabled: true, windowMin: 30 }),
      rollbackContext: vi.fn().mockResolvedValue({ apps: new Map([[APP, ctxApp(app)]]), inFlight }),
      approveAutoRollback: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({ ...row({ id: "rb-1", action: "vercel_rollback", status: "done", auto: true }), id: "rb-1" }),
      notifyRollback: vi.fn().mockResolvedValue(undefined),
      ...o,
    });

    it("runs a fresh broken deploy's rollback as office-auto, with the auto reason, and reports it on Telegram", async () => {
      const d = rbDeps();
      expect(await runProposalsStep(now, {}, d)).toMatchObject({ created: 1, autoRan: 1 });
      expect(d.approveAutoRollback).toHaveBeenCalledWith("rb-1", "Automatic: the new deploy abcdef1 errored in the first 30 minutes. app-a /. Down.", expect.any(Date));
      expect(d.execute).toHaveBeenCalledWith("rb-1", expect.any(Date));
      expect(d.notifyRollback).toHaveBeenCalledWith(expect.objectContaining({ id: "rb-1", status: "done" }), { reason: "app-a /. Down.", newRef: "abcdef1" });
      expect(d.notifyNew).toHaveBeenCalledWith([], {}, { devQueued: new Set() });
      expect(d.notifyResult).not.toHaveBeenCalled();
    });
    it("does nothing when off, for HighLatency, or when a guard says no", async () => {
      for (const d of [
        rbDeps({ autoRollback: vi.fn().mockResolvedValue({ enabled: false, windowMin: 30 }) }),
        rbDeps({ logs: vi.fn().mockResolvedValue({ created: [rb({ ruleKey: "HighLatency" })], expired: 0 }) }),
        rbDeps({}, { autoLately: true }),
        rbDeps({}, { rolledOrPromotedLately: true }),
        rbDeps({}, {}, true),
      ]) {
        await runProposalsStep(now, {}, d);
        expect(d.approveAutoRollback).not.toHaveBeenCalled();
        expect(d.execute).not.toHaveBeenCalled();
        expect(d.notifyNew).toHaveBeenCalledWith([expect.objectContaining({ id: "rb-1" })], {}, { devQueued: new Set() });
      }
    });
    it("runs at most one per minute, and a lost approval (another in flight) runs nothing", async () => {
      const two = rbDeps({ logs: vi.fn().mockResolvedValue({ created: [rb(), rb({ id: "rb-2" })], expired: 0 }) });
      await runProposalsStep(now, {}, two);
      expect(two.execute).toHaveBeenCalledTimes(1);
      const lost = rbDeps({ approveAutoRollback: vi.fn().mockResolvedValue(false) });
      await runProposalsStep(now, {}, lost);
      expect(lost.execute).not.toHaveBeenCalled();
    });
  });

  describe("automatic security fixes", () => {
    const REPO = "55555555-5555-4555-8555-555555555555";
    const bump = (o: object = {}) => row({ id: "bump-1", action: "github_bump_pr", risk: "risky", ruleKey: "VulnerableDependency", resourceId: APP, targetRef: REPO, ...o });
    const secDeps = (o: Partial<StepDeps> = {}) => deps({
      firing: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue({ created: [bump()], expired: 0 }),
      autoSecurity: vi.fn().mockResolvedValue({ enabled: true, severities: ["critical", "high"], sameMajorOnly: true }),
      bumpReady: vi.fn().mockResolvedValue({ ok: true }), approveAutoBump: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({ ...row({ id: "bump-1", action: "github_bump_pr", status: "done", auto: true }), id: "bump-1" }),
      ...o,
    });
    it("opens the PR without asking when the policy allows it, and reports the result", async () => {
      const d = secDeps();
      expect(await runProposalsStep(now, {}, d)).toMatchObject({ created: 1, autoRan: 1 });
      expect(d.bumpReady).toHaveBeenCalledWith(REPO, ["critical", "high"]);
      expect(d.approveAutoBump).toHaveBeenCalledWith("bump-1", expect.any(Date));
      expect(d.notifyResult).toHaveBeenCalledWith(expect.objectContaining({ id: "bump-1", status: "done", auto: true }));
      expect(d.notifyNew).toHaveBeenCalledWith([], {}, { devQueued: new Set() });
    });
    it("stays pending for the owner when off, or when the policy says no (severity, major, no token)", async () => {
      for (const d of [
        secDeps({ autoSecurity: vi.fn().mockResolvedValue({ enabled: false, severities: ["critical"], sameMajorOnly: true }) }),
        secDeps({ bumpReady: vi.fn().mockResolvedValue({ ok: false, why: "major" }) }),
        secDeps({ bumpReady: vi.fn().mockResolvedValue({ ok: false, why: "no write token" }) }),
      ]) {
        await runProposalsStep(now, {}, d);
        expect(d.approveAutoBump).not.toHaveBeenCalled();
        expect(d.execute).not.toHaveBeenCalled();
        expect(d.notifyNew).toHaveBeenCalledWith([expect.objectContaining({ id: "bump-1" })], {}, { devQueued: new Set() });
      }
    });
  });

  it("queues a Dev note for a new LogErrorSpike proposal and tells the notice", async () => {
    const spike = row({ id: "spike-1", action: "vercel_rollback", risk: "risky", ruleKey: "LogErrorSpike", resourceId: APP });
    const d = deps({ firing: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue({ created: [spike], expired: 0 }), queueDev: vi.fn().mockResolvedValue(new Set(["spike-1"])) });
    await runProposalsStep(now, {}, d);
    expect(d.queueDev).toHaveBeenCalledWith([{ proposalId: "spike-1", appId: APP }], now);
    expect(d.notifyNew).toHaveBeenCalledWith([expect.objectContaining({ id: "spike-1" })], {}, { devQueued: new Set(["spike-1"]) });
  });
  it("still creates and notifies a LogErrorSpike proposal when no Dev hook is wired", async () => {
    const spike = row({ id: "spike-1", action: "vercel_rollback", risk: "risky", ruleKey: "LogErrorSpike", resourceId: APP });
    const d = deps({ firing: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue({ created: [spike], expired: 0 }), queueDev: undefined });
    expect(await runProposalsStep(now, {}, d)).toMatchObject({ created: 1 });
    expect(d.notifyNew).toHaveBeenCalledWith([expect.objectContaining({ id: "spike-1" })], {}, { devQueued: new Set() });
  });
  it("adds the log proposals to the same notice and auto-run flow, even with nothing firing", async () => {
    const logRow = row({ id: "log-1", action: "recheck" });
    const d = deps({ firing: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue({ created: [logRow], expired: 1 }), autoRun: vi.fn().mockResolvedValue({ ...off, recheck: true }) });
    expect(await runProposalsStep(now, {}, d)).toEqual({ created: 1, expired: 1, autoRan: 1 });
    expect(d.approveAuto).toHaveBeenCalledWith("log-1", expect.any(Date));
  });
  it("a failing log check never fails the step; no log check with under 10 s left", async () => {
    const d = deps({ logs: vi.fn().mockRejectedValue(new Error("db")) });
    expect(await runProposalsStep(now, {}, d)).toMatchObject({ created: 1 });
    const late = deps();
    await runProposalsStep(now, { deadline: Date.now() + 5000 }, late);
    expect(late.logs).not.toHaveBeenCalled();
  });
});

describe("runLogProposals / readLogApps", () => {
  const LOGAPP = {
    appId: APP, appName: "shortly", liveAt: null, currentId: "dpl_cur00000001", previousId: null, lastDeployAt: null, errorsSinceLive: 0, baselineErrors: 0,
    topSinceLive: null, errors30: 25, top30: "Error: boom", dbErrors30: 0, topDb: null, httpMonitorId: MON, db: null,
  };
  it("inserts a fresh LogErrors recheck with no alert, and expires a pending one whose condition stopped", async () => {
    const OLD = "923e4567-e89b-42d3-a456-426614174000";
    const f = fakeDb([], [[{ id: OLD }], [row({ id: "new" })]]);
    h.current = f;
    const r = await runLogProposals(now, EMPTY_BOOK, {
      apps: vi.fn().mockResolvedValue([LOGAPP]),
      rows: vi.fn().mockResolvedValue([{ id: OLD, ruleKey: "LogDbErrors", resourceId: APP, action: "neon_wake", status: "pending", closedAt: null }]),
    });
    expect(r.expired).toBe(1);
    expect(r.created).toHaveLength(1);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ status: "expired" });
    const values = payloadOf(f.writes[1].calls) as unknown as Record<string, unknown>[];
    expect(values[0]).toMatchObject({ alertId: null, ruleKey: "LogErrors", action: "recheck", targetRef: MON, status: "pending", room: "workloads" });
  });
  it("skips one that is open or closed within 2 h", async () => {
    const f = fakeDb([], []);
    h.current = f;
    const r = await runLogProposals(now, EMPTY_BOOK, {
      apps: vi.fn().mockResolvedValue([LOGAPP]),
      rows: vi.fn().mockResolvedValue([{ id: "x", ruleKey: "LogErrors", resourceId: APP, action: "recheck", status: "rejected", closedAt: new Date(now.getTime() - 3_600_000) }]),
    });
    expect(r).toEqual({ created: [], expired: 0 });
    expect(f.writes).toHaveLength(0);
  });
  it("reads one aggregate of the last 26 h and stops when no app crosses a threshold", async () => {
    const f = fakeDb([[{ ...LOGAPP, errors30: 3 }]]);
    h.current = f;
    expect(await readLogApps(now)).toEqual([]);
    expect(f.queries).toHaveLength(1);
    const where = render(whereOf(f.queries[0])!);
    expect(where.params).toContain("2026-10-14T03:00:00.000Z");
  });
  it("reads the hot apps' context in three more small reads", async () => {
    // The three context reads run in parallel: each answer looks at what was selected.
    const by = (calls: { method: string; args: unknown[] }[]) => {
      const keys = Object.keys((calls[0]?.args[0] ?? {}) as object);
      if (keys.includes("previousId")) return [{ app: APP, previousId: "dpl_prv00000001", lastDeployAt: null }];
      if (keys.includes("parentId")) return [];
      return [{ app: APP, id: MON }];
    };
    const f = fakeDb([[LOGAPP], by, by, by]);
    h.current = f;
    const [a] = await readLogApps(now);
    expect(a).toMatchObject({ appId: APP, previousId: "dpl_prv00000001", httpMonitorId: MON, db: null, errors30: 25 });
    expect(f.queries).toHaveLength(4);
  });
});
