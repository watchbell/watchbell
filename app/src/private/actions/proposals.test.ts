import { describe, expect, it } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import type { AliasBook } from "@/lib/view/display-name";
import {
  autoRuns, factNeeds, isExpired, parseDecideBody, parseProposalLimit, type ProposalAlert, type ProposalFacts, proposalsFor, proposalTitle,
  resultSentence, toProposal, wakeableEndpoint,
} from "./proposals";
import { ACTIONS, type AutoRun, PROPOSAL_TTL_MS } from "./proposals-types";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const DB = "223e4567-e89b-42d3-a456-426614174000";
const MON = "323e4567-e89b-42d3-a456-426614174000";
const NEON = "423e4567-e89b-42d3-a456-426614174000";
const ALERT = "523e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-10-15T05:00:00Z");
const book: AliasBook = { db: [{ id: DB, name: "ticketer-db", alias: "db-a" }, { id: NEON, name: "neon-main", alias: "db-b" }], app: [{ id: APP, name: "shortly", alias: "app-a" }] };

const alert = (o: Partial<ProposalAlert>): ProposalAlert => ({
  id: ALERT, ruleKey: "MonitorDown", subject: MON, severity: "critical", title: "shortly /", message: "3 consecutive checks failed: HTTP 500 (owner@example.com).",
  resourceId: APP, resourceKind: "app", resourceName: "shortly", causedBy: null, silencedUntil: null, silencedUntilResolved: false,
  startedAt: new Date(now.getTime() - 60_000), ...o,
});
const facts = (o: Partial<ProposalFacts> = {}): ProposalFacts => ({
  monitorKinds: new Map([[MON, "http"]]), deploys: new Map(), supabaseRefs: new Map(), neonSuspended: new Map(), ...o,
});
const off: AutoRun = { recheck: false, neon_wake: false, supabase_keepalive: false, supabase_restore: false, vercel_redeploy: false, vercel_rollback: false, github_bump_pr: false, domain_recheck: false, daily_rerun: false, monitor_update_url: false };

describe("proposalsFor", () => {
  it("MonitorDown on an HTTP monitor → recheck, in Workloads, aliased, no email, expires after the TTL", () => {
    const [p, ...rest] = proposalsFor(alert({}), facts(), book, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ action: "recheck", risk: "safe", room: "workloads", resourceId: APP, targetRef: MON, resourceName: "app-a", title: "Check app-a again now", proposedBy: ACTIONS_COPY.proposedBy("Workloads") });
    expect(p.reason).not.toMatch(/@|shortly/);
    expect(p.reason.length).toBeLessThanOrEqual(200);
    expect(p.expiresAt.getTime()).toBe(now.getTime() + PROPOSAL_TTL_MS);
  });
  it("a heartbeat can't be rechecked; a silenced alert gets nothing", () => {
    expect(proposalsFor(alert({}), facts({ monitorKinds: new Map([[MON, "heartbeat"]]) }), book, now)).toEqual([]);
    expect(proposalsFor(alert({ silencedUntilResolved: true }), facts(), book, now)).toEqual([]);
    expect(proposalsFor(alert({ silencedUntil: new Date(now.getTime() + 60_000) }), facts(), book, now)).toEqual([]);
  });
  it("adds neon_wake (Databases) when the app's linked Neon compute is suspended", () => {
    const f = facts({ neonSuspended: new Map([[APP, { resourceId: NEON, resourceKind: "neon_project" as const, endpointId: "ep-cool-dawn-123" }]]) });
    const ps = proposalsFor(alert({ ruleKey: "HighLatency" }), f, book, now);
    expect(ps.map((p) => p.action)).toEqual(["recheck", "neon_wake"]);
    expect(ps[1]).toMatchObject({ room: "databases", resourceId: NEON, targetRef: "ep-cool-dawn-123", resourceName: "db-b", proposedBy: ACTIONS_COPY.proposedBy("Databases") });
  });
  it("DeploymentFailed → redeploy the live one, and rollback only with a previous ready deployment", () => {
    const a = alert({ ruleKey: "DeploymentFailed", subject: APP, severity: "warning" });
    expect(proposalsFor(a, facts({ deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId: null }]]) }), book, now).map((p) => [p.action, p.targetRef, p.risk]))
      .toEqual([["vercel_redeploy", "dpl_cur00000001", "risky"]]);
    const both = proposalsFor(a, facts({ deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId: "dpl_prv00000001" }]]) }), book, now);
    expect(both.map((p) => p.action)).toEqual(["vercel_redeploy", "vercel_rollback"]);
    expect(both[0].title).toBe("Redeploy production app-a");
    expect(proposalsFor(a, facts(), book, now)).toEqual([]);
  });
  it("DatabasePaused → supabase_restore, AutoPauseRisk → supabase_keepalive, with the ref and the db alias", () => {
    const f = facts({ supabaseRefs: new Map([[DB, "abcdefghijklmnopqrst"]]) });
    const base = { subject: DB, resourceId: DB, resourceKind: "supabase_project", resourceName: "ticketer-db", title: "ticketer-db", message: "Supabase project ticketer-db is paused." };
    const [r] = proposalsFor(alert({ ...base, ruleKey: "DatabasePaused", severity: "warning" }), f, book, now);
    expect(r).toMatchObject({ action: "supabase_restore", risk: "risky", room: "databases", targetRef: "abcdefghijklmnopqrst", resourceName: "db-a", title: "Restore Supabase project db-a" });
    expect(r.reason).not.toContain("ticketer");
    const [k] = proposalsFor(alert({ ...base, ruleKey: "AutoPauseRisk", severity: "info" }), f, book, now);
    expect(k).toMatchObject({ action: "supabase_keepalive", risk: "safe" });
    expect(proposalsFor(alert({ ...base, ruleKey: "DatabasePaused" }), facts(), book, now)).toEqual([]);
  });
  it("every other rule gets nothing", () => {
    for (const ruleKey of ["CertExpiringSoon", "StorageAlmostFull", "NeonComputeHigh", "CollectorStale", "CredentialExpiring", "SomethingNew"]) {
      expect(proposalsFor(alert({ ruleKey }), facts(), book, now)).toEqual([]);
    }
  });
  it("titles stay within 200 characters", () => {
    expect(proposalTitle("vercel_rollback", "x".repeat(300)).length).toBe(200);
  });
});

describe("factNeeds", () => {
  it("asks only for what the alerts need", () => {
    const need = factNeeds([alert({}), alert({ ruleKey: "DeploymentFailed", subject: APP }), alert({ ruleKey: "CertExpiringSoon" }), alert({ ruleKey: "DatabasePaused", resourceKind: "supabase_project", resourceId: DB })], now);
    expect(need).toEqual({ monitorIds: [MON], monitorApps: [APP], deployApps: [APP], supabaseIds: [DB], depApps: [], frameworkApps: [] });
    // Down / slow apps need their deploys too (auto-rollback rule).
    expect(factNeeds([alert({})], now).deployApps).toEqual([APP]);
    expect(Object.values(factNeeds([alert({ ruleKey: "CertExpiringSoon" })], now)).flat()).toEqual([]);
  });
});

describe("wakeableEndpoint", () => {
  const ep = (o: object) => ({ id: "ep-a-1", branchId: "br-main", state: "idle", pendingState: null, disabled: false, ...o });
  const branches = [{ id: "br-main", isDefault: true }, { id: "br-dev", isDefault: false }];
  it("is the default branch's suspended compute, or the given branch's", () => {
    expect(wakeableEndpoint([ep({})], branches, null)).toBe("ep-a-1");
    expect(wakeableEndpoint([ep({}), ep({ id: "ep-b-2", branchId: "br-dev" })], branches, "br-dev")).toBe("ep-b-2");
  });
  it("is null when running, starting, disabled or missing", () => {
    expect(wakeableEndpoint([ep({ state: "active" })], branches, null)).toBeNull();
    expect(wakeableEndpoint([ep({ pendingState: "active" })], branches, null)).toBeNull();
    expect(wakeableEndpoint([ep({ disabled: true })], branches, null)).toBeNull();
    expect(wakeableEndpoint(undefined, undefined, null)).toBeNull();
  });
});

describe("expiry, auto-run, results and parsing", () => {
  it("expires a pending one past its time or when its alert stopped firing", () => {
    const p = { status: "pending" as const, expiresAt: new Date(now.getTime() + 1000), alertId: ALERT };
    expect(isExpired(p, new Set([ALERT]), now)).toBe(false);
    expect(isExpired(p, new Set(), now)).toBe(true);
    expect(isExpired({ ...p, expiresAt: now }, new Set([ALERT]), now)).toBe(true);
    expect(isExpired({ ...p, status: "approved" }, new Set(), now)).toBe(false);
  });
  it("auto-runs only safe kinds the owner switched on, never risky ones", () => {
    expect(autoRuns("recheck", off)).toBe(false);
    expect(autoRuns("recheck", { ...off, recheck: true })).toBe(true);
    expect(autoRuns("vercel_redeploy", { ...off, vercel_redeploy: true })).toBe(false);
    expect(autoRuns("supabase_restore", { ...off, supabase_restore: true })).toBe(false);
  });
  it("scrubs a result sentence and keeps it ≤ 200", () => {
    expect(resultSentence({ ok: true, message: "Redeploy requested. Vercel is building shortly again." }, book)).toBe("Redeploy requested. Vercel is building app-a again.");
    expect(resultSentence({ ok: false, error: "x".repeat(400) }, book).length).toBe(200);
    expect(resultSentence({ ok: true }, book)).toBe("Done.");
  });
  it("maps a row to the contract shape", () => {
    const p = toProposal({ id: "p1", room: "workloads", action: "recheck", risk: "safe", title: "t", reason: "r", resourceName: "app-a", proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: now, decidedAt: null, expiresAt: now });
    expect(p).toEqual({ id: "p1", room: "workloads", action: "recheck", actionLabel: ACTIONS.recheck.label, risk: "safe", title: "t", reason: "r", resourceName: "app-a", proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: now.toISOString(), decidedAt: null, expiresAt: now.toISOString() });
  });
  it("parses the limit and the decide body strictly", () => {
    expect([parseProposalLimit(null), parseProposalLimit("5"), parseProposalLimit("500"), parseProposalLimit("0"), parseProposalLimit("x")]).toEqual([20, 5, 50, 20, 20]);
    expect(parseDecideBody({ decision: "approve" })).toEqual({ ok: true, data: { decision: "approve" } });
    expect(parseDecideBody({ decision: "reject" })).toEqual({ ok: true, data: { decision: "reject" } });
    for (const b of [null, [], {}, { decision: "run" }, { decision: "approve", extra: 1 }]) expect(parseDecideBody(b).ok).toBe(false);
  });
});

describe("auto-rollback rule: a rollback proposal for a down or slow app right after a new deploy", () => {
  const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const fresh = (liveAt: Date | null, previousId: string | null = "dpl_prv00000001") =>
    facts({ deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId, liveAt }]]), previousNext: new Map([[APP, { status: "ok" as const, version: "16.3.8" }]]) });
  it("MonitorDown / HighLatency within the window → recheck plus vercel_rollback to the previous deployment", () => {
    for (const ruleKey of ["MonitorDown", "HighLatency"]) {
      const ps = proposalsFor(alert({ ruleKey }), fresh(minAgo(20)), book, now);
      expect(ps.map((p) => p.action)).toEqual(["recheck", "vercel_rollback"]);
      expect(ps[1]).toMatchObject({ targetRef: "dpl_prv00000001", risk: "risky", room: "workloads", ruleKey });
    }
  });
  // Watchbell 1.2.1: a monitor whose host the app no longer has is a moved domain, not a broken deploy.
  it("never proposes a redeploy or a rollback for a monitor on a detached host, in the window or outside it", () => {
    const moves = new Map([[MON, { from: "old.example.com", to: "new.example.com" }]]);
    for (const at of [minAgo(90), minAgo(10)]) {
      const f = { ...fresh(at), monitorMoves: moves };
      expect(proposalsFor(alert({}), f, book, now).map((p) => p.action)).toEqual(["recheck"]);
      expect(proposalsFor(alert({ ruleKey: "HighLatency" }), f, book, now).map((p) => p.action)).toEqual(["recheck"]);
    }
  });
  it("MonitorDomainMoved → monitor_update_url (safe) for that monitor; nothing without a known move", () => {
    const moved = alert({ ruleKey: "MonitorDomainMoved", severity: "warning", message: "old.example.com is no longer a domain of shortly; production is on new.example.com." });
    const moves = new Map([[MON, { from: "old.example.com", to: "new.example.com" }]]);
    const [p, ...rest] = proposalsFor(moved, { ...fresh(minAgo(90)), monitorMoves: moves }, book, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ action: "monitor_update_url", risk: "safe", room: "workloads", resourceKind: "app", resourceId: APP, targetRef: MON, title: "Point the app-a monitor at new.example.com" });
    expect(proposalsFor(moved, facts(), book, now)).toEqual([]);
    expect(factNeeds([moved], now).monitorIds).toEqual([MON]);
  });
  it("window math (a slow app): the default 30 min, or the setting's window; nothing older, nothing without a previous deployment", () => {
    const slow = alert({ ruleKey: "HighLatency" });
    expect(proposalsFor(slow, fresh(minAgo(30)), book, now).map((p) => p.action)).toContain("vercel_rollback");
    expect(proposalsFor(slow, fresh(minAgo(31)), book, now).map((p) => p.action)).not.toContain("vercel_rollback");
    const f60 = { ...fresh(minAgo(55)), rollbackWindowMs: 60 * 60_000 };
    expect(proposalsFor(slow, f60, book, now).map((p) => p.action)).toContain("vercel_rollback");
    expect(proposalsFor(slow, fresh(minAgo(5), null), book, now).map((p) => p.action)).not.toContain("vercel_rollback");
    expect(proposalsFor(slow, fresh(null), book, now).map((p) => p.action)).not.toContain("vercel_rollback");
  });
  it("a down site outside the window (owner 17 Oct; D17: no rollback any more): recheck, then a redeploy for the owner to approve", () => {
    const ps = proposalsFor(alert({}), fresh(minAgo(90)), book, now);
    expect(ps.map((p) => [p.action, p.targetRef, p.risk])).toEqual([["recheck", MON, "safe"], ["vercel_redeploy", "dpl_cur00000001", "risky"]]);
    // Without a previous deployment only the redeploy; without any deployment (not a Vercel app) only the recheck.
    expect(proposalsFor(alert({}), fresh(minAgo(90), null), book, now).map((p) => p.action)).toEqual(["recheck", "vercel_redeploy"]);
    expect(proposalsFor(alert({}), facts(), book, now).map((p) => p.action)).toEqual(["recheck"]);
    // Within the window the auto-rollback rule's single rollback, no redeploy next to it.
    expect(proposalsFor(alert({}), fresh(minAgo(10)), book, now).map((p) => p.action)).toEqual(["recheck", "vercel_rollback"]);
    // A failed heartbeat is a job, not the site: no redeploy for it.
    const hb = facts({ monitorKinds: new Map([[MON, "heartbeat"]]), deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId: "dpl_prv00000001", liveAt: minAgo(90) }]]) });
    expect(proposalsFor(alert({}), hb, book, now)).toEqual([]);
  });
});

// Watchbell 1.2.2 (D17, seen 24 Oct): days of HighLatency got a rollback proposal because the app had deployed.
describe("a rollback only when a fresh deploy caused it, never back to a vulnerable Next.js", () => {
  const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const deploys = (liveAt: Date) => new Map([[APP, { currentId: "dpl_cur00000001", previousId: "dpl_prv00000001", liveAt }]]);
  const prev = (status: "ok" | "vulnerable" | "unknown", version: string | null = "16.3.8") => new Map([[APP, { status, version }]]);
  const actions = (ps: { action: string }[]) => ps.map((p) => p.action);

  it("chronic latency (the same alert was firing before the deploy) → no rollback; the recheck says it isn't the deploy", () => {
    const f = facts({ deploys: deploys(minAgo(20)), previousNext: prev("ok"), problemSince: new Map([[ALERT, new Date("2026-10-12T02:00:00Z")]]) });
    const ps = proposalsFor(alert({ ruleKey: "HighLatency", startedAt: minAgo(5) }), f, book, now);
    expect(actions(ps)).toEqual(["recheck"]);
    expect(ps[0].reason).toMatch(/^Slow since 12 Oct 09:00 WIB, not tied to a deploy \(live since 15 Oct 11:40 WIB\): check the app\. /);
    expect(ps[0].reason.length).toBeLessThanOrEqual(200);
  });
  it("an alert that started before the deploy went live → no rollback, in the window or outside it, and never a redeploy for latency", () => {
    for (const live of [minAgo(20), minAgo(300)]) {
      const f = facts({ deploys: deploys(live), previousNext: prev("ok") });
      const slow = proposalsFor(alert({ ruleKey: "HighLatency", startedAt: minAgo(400) }), f, book, now);
      expect(actions(slow)).toEqual(["recheck"]);
      expect(slow[0].reason).toMatch(/^Slow since /);
      const down = proposalsFor(alert({ startedAt: minAgo(400) }), f, book, now);
      expect(actions(down)).toEqual(["recheck"]);
      expect(down[0].reason).toMatch(/^Down since .*not tied to a deploy/);
    }
    // Slow long after the deploy went live (review M1): said as such, with the by-hand way out.
    const late = proposalsFor(alert({ ruleKey: "HighLatency" }), facts({ deploys: deploys(minAgo(300)), previousNext: prev("ok") }), book, now);
    expect(actions(late)).toEqual(["recheck"]);
    expect(late[0].reason).toMatch(/^Slow since 15 Oct 11:59 WIB, 5 h after the deploy went live, outside the rollback window: check the app or roll back by hand\. /);
  });
  it("inside the window with nothing to roll back to (a first deploy): the note says when it started, not 'outside the window'", () => {
    const first = facts({ deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId: null, liveAt: minAgo(20) }]]) });
    const ps = proposalsFor(alert({ ruleKey: "HighLatency", startedAt: minAgo(5) }), first, book, now);
    expect(actions(ps)).toEqual(["recheck"]);
    expect(ps[0].reason).toMatch(/^Slow since 15 Oct 11:55 WIB, started 15 min after the deploy went live: check the app\. /);
  });
  it("latency starting right after a fresh deploy → rollback proposed (the reason is the alert's)", () => {
    const ps = proposalsFor(alert({ ruleKey: "HighLatency", startedAt: minAgo(5) }), facts({ deploys: deploys(minAgo(20)), previousNext: prev("ok") }), book, now);
    expect(actions(ps)).toEqual(["recheck", "vercel_rollback"]);
    expect(ps[1].reason).toBe(ps[0].reason);
    expect(ps[1].reason).not.toMatch(/since|unknown/);
  });
  it("the previous deployment's Next.js has known advisories → no rollback, for any alert", () => {
    const f = facts({ deploys: deploys(minAgo(20)), previousNext: prev("vulnerable") });
    const slow = proposalsFor(alert({ ruleKey: "HighLatency", startedAt: minAgo(5) }), f, book, now);
    expect(actions(slow)).toEqual(["recheck"]);
    expect(slow[0].reason).toMatch(/^No rollback: the previous deployment runs Next\.js 16\.3\.8, which has known advisories\. /);
    // A down site that started failing with this deploy gets the redeploy instead, waiting for approval.
    const down = proposalsFor(alert({ startedAt: minAgo(5) }), f, book, now);
    expect(actions(down)).toEqual(["recheck", "vercel_redeploy"]);
    expect(down[1].reason).toMatch(/^No rollback: /);
    const failed = proposalsFor(alert({ ruleKey: "DeploymentFailed", subject: APP, severity: "warning" }), f, book, now);
    expect(actions(failed)).toEqual(["vercel_redeploy"]);
  });
  it("an unknown previous Next.js → the rollback is still proposed, and its reason says so first", () => {
    for (const previousNext of [prev("unknown", null), undefined]) {
      const ps = proposalsFor(alert({ startedAt: minAgo(5) }), facts({ deploys: deploys(minAgo(20)), previousNext }), book, now);
      expect(actions(ps)).toEqual(["recheck", "vercel_rollback"]);
      expect(ps[1].reason).toMatch(/^Previous deployment's Next\.js version is unknown: check it has no known advisories before approving\. /);
      expect(ps[1].reason.length).toBeLessThanOrEqual(200);
      expect(ps[0].reason).not.toMatch(/unknown/);
    }
  });
  it("MonitorDown right after a deploy: unchanged (recheck, rollback); outside the window: recheck, redeploy", () => {
    const ok = prev("ok");
    expect(actions(proposalsFor(alert({ startedAt: minAgo(5) }), facts({ deploys: deploys(minAgo(20)), previousNext: ok }), book, now))).toEqual(["recheck", "vercel_rollback"]);
    expect(actions(proposalsFor(alert({ startedAt: minAgo(5) }), facts({ deploys: deploys(minAgo(300)), previousNext: ok }), book, now))).toEqual(["recheck", "vercel_redeploy"]);
    // Not knowing when it started (no deploy time) keeps the redeploy.
    const noTime = facts({ deploys: new Map([[APP, { currentId: "dpl_cur00000001", previousId: "dpl_prv00000001", liveAt: null }]]), previousNext: ok });
    expect(actions(proposalsFor(alert({}), noTime, book, now))).toEqual(["recheck", "vercel_redeploy"]);
  });
});

describe("daily_rerun (owner 19 Oct)", () => {
  const HB = "823e4567-e89b-42d3-a456-426614174000";
  const down = alert({ subject: HB, title: "daily job", message: "No ping for 31 h." });
  const hbFacts = (o: Partial<ProposalFacts> = {}) => facts({ monitorKinds: new Map([[HB, "heartbeat"]]), dailyHeartbeatId: HB, ...o });
  it("MonitorDown on the daily heartbeat → daily_rerun (risky, observe room, target = the monitor)", () => {
    const [p, ...rest] = proposalsFor(down, hbFacts(), book, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ action: "daily_rerun", risk: "risky", room: "observe", resourceId: APP, targetRef: HB, title: "Rerun the daily job" });
  });
  it("nothing when the daily heartbeat is unknown, or the alert is another monitor", () => {
    expect(proposalsFor(down, hbFacts({ dailyHeartbeatId: null }), book, now)).toEqual([]);
    expect(proposalsFor(down, facts({ monitorKinds: new Map([[HB, "heartbeat"]]) }), book, now)).toEqual([]);
    expect(proposalsFor(alert({ subject: MON }), facts({ dailyHeartbeatId: HB }), book, now).map((p) => p.action)).toEqual(["recheck"]);
    expect(proposalsFor({ ...down, ruleKey: "HighLatency" }, hbFacts(), book, now)).toEqual([]);
  });
  it("is risky and never runs automatically", () => {
    expect(ACTIONS.daily_rerun).toMatchObject({ risk: "risky", label: "Rerun daily job" });
    expect(autoRuns("daily_rerun", Object.fromEntries(Object.keys(off).concat("daily_rerun").map((k) => [k, true])) as AutoRun)).toBe(false);
  });
});

describe("CertExpiringSoon (owner 17 Oct)", () => {
  const DOM = "623e4567-e89b-42d3-a456-426614174000";
  const cert = alert({ ruleKey: "CertExpiringSoon", subject: DOM, severity: "warning", resourceId: DOM, resourceKind: "domain", resourceName: "shop.example.com", title: "shop.example.com", message: "TLS certificate expires in 9 days." });
  it("→ domain_recheck (safe) in Network, targeting the domain", () => {
    const [p, ...rest] = proposalsFor(cert, facts(), book, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ action: "domain_recheck", risk: "safe", room: "network", resourceKind: "domain", resourceId: DOM, targetRef: DOM, proposedBy: ACTIONS_COPY.proposedBy("Network") });
    expect(p.title).toMatch(/^Re-check the certificate of /);
  });
  it("nothing for a malformed domain id", () => {
    expect(proposalsFor({ ...cert, resourceId: "nope" }, facts(), book, now)).toEqual([]);
  });
});

describe("github_bump_pr in Indonesian", () => {
  const vuln = alert({ ruleKey: "VulnerableDependency", subject: APP, severity: "warning", title: "shortly", message: "2 vulnerable packages (1 critical, 1 high): next 15.0.0 → 15.0.5, lodash 4.17.0 (no fix yet)." });
  it("title and reason", () => {
    const [p] = proposalsFor(vuln, facts({ fixableRepos: new Map([[APP, DB]]) }), book, now);
    expect(p.title).toBe("Open a PR updating vulnerable packages in app-a");
    expect(p.reason).toBe("Vulnerable packages in app-a have a fix: next 15.0.0 → 15.0.5, lodash 4.17.0 (no fix yet).");
    expect(proposalTitle("github_bump_pr", "app-t")).toBe("Open a PR updating vulnerable packages in app-t");
  });
});
