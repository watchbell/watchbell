import { describe, expect, it } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import type { AliasBook } from "@/lib/view/display-name";
import {
  DB_ERROR, freshLogDrafts, isDbErrorLine, type LogApp, type LogDraft, logProposalsFor, type LogRow, logsDue, spikeThreshold, staleLogIds,
} from "./log-proposals";
import { PROPOSAL_TTL_MS } from "./proposals-types";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const NEON = "423e4567-e89b-42d3-a456-426614174000";
const SUPA = "223e4567-e89b-42d3-a456-426614174000";
const MON = "723e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-10-15T05:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const book: AliasBook = {
  db: [{ id: NEON, name: "neon-main", alias: "db-b" }, { id: SUPA, name: "ticketer-db", alias: "db-a" }],
  app: [{ id: APP, name: "shortly", alias: "app-a" }],
};

const app = (o: Partial<LogApp> = {}): LogApp => ({
  appId: APP, appName: "shortly", liveAt: ago(30), currentId: "dpl_cur00000001", previousId: "dpl_prv00000001", lastDeployAt: ago(30),
  errorsSinceLive: 0, baselineErrors: 0, topSinceLive: null, errors30: 0, top30: null, dbErrors30: 0, topDb: null, httpMonitorId: MON, db: null, ...o,
});

describe("LogErrorSpike", () => {
  it("threshold is max(10, 5 × the hourly baseline)", () => {
    expect(spikeThreshold(0)).toBe(10);
    expect(spikeThreshold(48)).toBe(10);
    expect(spikeThreshold(240)).toBe(50);
  });
  it("proposes a rollback (risky) to the previous ready deployment, with a scrubbed reason", () => {
    const [p, ...rest] = logProposalsFor(app({ errorsSinceLive: 12, baselineErrors: 24, topSinceLive: "TypeError at https://shortly.vercel.app/api for owner@example.com" }), book, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      alertId: null, ruleKey: "LogErrorSpike", room: "workloads", action: "vercel_rollback", risk: "risky", resourceId: APP, targetRef: "dpl_prv00000001",
      resourceName: "app-a", title: "Roll app-a back to the previous deployment", proposedBy: ACTIONS_COPY.proposedBy("Workloads"),
    });
    expect(p.reason).toMatch(/^12 errors since the deploy went live 30 min ago \(24 in the 24 h before\)\. Most common: TypeError/);
    expect(p.reason).not.toMatch(/@|shortly|vercel\.app/);
    expect(p.reason.length).toBeLessThanOrEqual(200);
    expect(p.expiresAt.getTime()).toBe(now.getTime() + PROPOSAL_TTL_MS);
  });
  it("not below the threshold, not 2 h after going live, not without a previous deployment", () => {
    expect(logProposalsFor(app({ errorsSinceLive: 9 }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ errorsSinceLive: 40, baselineErrors: 240 }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ errorsSinceLive: 40, liveAt: ago(121) }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ errorsSinceLive: 40, previousId: null }), book, now)).toEqual([]);
  });
});

describe("LogErrors", () => {
  it("≥ 20 errors in 30 min and no deploy for 2 h → recheck (safe) of the HTTP monitor", () => {
    const [p] = logProposalsFor(app({ errors30: 20, top30: "500 GET /api", liveAt: ago(600), lastDeployAt: ago(600) }), book, now);
    expect(p).toMatchObject({ ruleKey: "LogErrors", action: "recheck", risk: "safe", targetRef: MON, room: "workloads", title: "Check app-a again now" });
    expect(p.reason).toBe("20 errors in the last 30 min. Most common: 500 GET /api");
  });
  it("not after a recent deploy, not without an HTTP monitor, not below 20", () => {
    expect(logProposalsFor(app({ errors30: 30, liveAt: ago(600), lastDeployAt: ago(60) }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ errors30: 30, liveAt: ago(600), lastDeployAt: null, httpMonitorId: null }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ errors30: 19, liveAt: ago(600), lastDeployAt: null }), book, now)).toEqual([]);
  });
});

describe("LogDbErrors", () => {
  const neon = { resourceId: NEON, kind: "neon_project", wakeEndpoint: "ep-cool-dawn-123", supabaseRef: null, supabasePaused: false };
  const supa = { resourceId: SUPA, kind: "supabase_project", wakeEndpoint: null, supabaseRef: "abcdefghijklmnopqrst", supabasePaused: true };
  it("a wakeable Neon compute → neon_wake (safe) in Databases, named by its alias", () => {
    const [p] = logProposalsFor(app({ dbErrors30: 3, topDb: "Error: Connection terminated unexpectedly", db: neon }), book, now);
    expect(p).toMatchObject({ ruleKey: "LogDbErrors", room: "databases", action: "neon_wake", risk: "safe", resourceId: NEON, targetRef: "ep-cool-dawn-123", resourceName: "db-b", proposedBy: ACTIONS_COPY.proposedBy("Databases") });
    expect(p.reason).toBe("3 database connection errors in the last 30 min. Most common: Error: Connection terminated unexpectedly");
  });
  it("a paused Supabase project → supabase_restore (risky); otherwise nothing", () => {
    expect(logProposalsFor(app({ dbErrors30: 5, db: supa }), book, now)[0]).toMatchObject({ action: "supabase_restore", risk: "risky", targetRef: "abcdefghijklmnopqrst", resourceName: "db-a" });
    expect(logProposalsFor(app({ dbErrors30: 5, db: { ...supa, supabasePaused: false } }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ dbErrors30: 5, db: { ...neon, wakeEndpoint: null } }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ dbErrors30: 5, db: null }), book, now)).toEqual([]);
    expect(logProposalsFor(app({ dbErrors30: 2, db: neon }), book, now)).toEqual([]);
  });
  it("recognises connection problems", () => {
    for (const m of ["Query timeout", "connect ECONNREFUSED 10.0.0.1:5432", "sorry, too many connections for role", "terminating connection due to administrator command", "Connection terminated", "The endpoint is disabled", "compute is suspended"]) {
      expect(isDbErrorLine(m)).toBe(true);
    }
    expect(isDbErrorLine("TypeError: x is undefined")).toBe(false);
    expect(DB_ERROR.flags).toContain("i");
  });
});

describe("dedupe, expiry, throttle", () => {
  const draft = logProposalsFor(app({ errors30: 25, liveAt: ago(600), lastDeployAt: null }), book, now) as LogDraft[];
  const row = (o: Partial<LogRow>): LogRow => ({ id: "r1", ruleKey: "LogErrors", resourceId: APP, action: "recheck", status: "pending", closedAt: null, ...o });
  it("skips a draft with an open proposal or one closed under 2 h ago; allows it after", () => {
    expect(freshLogDrafts(draft, [], now)).toHaveLength(1);
    expect(freshLogDrafts(draft, [row({ status: "running" })], now)).toEqual([]);
    expect(freshLogDrafts(draft, [row({ status: "rejected", closedAt: ago(119) })], now)).toEqual([]);
    expect(freshLogDrafts(draft, [row({ status: "rejected", closedAt: ago(121) })], now)).toHaveLength(1);
    expect(freshLogDrafts([...draft, ...draft], [], now)).toHaveLength(1);
  });
  it("expires pending log proposals whose condition no longer holds", () => {
    expect(staleLogIds([row({})], draft)).toEqual([]);
    expect(staleLogIds([row({})], [])).toEqual(["r1"]);
    expect(staleLogIds([row({ status: "approved" })], [])).toEqual([]);
    expect(staleLogIds([row({ ruleKey: "MonitorDown" })], [])).toEqual([]);
  });
  it("reads the logs once per 5-minute slot", () => {
    const slot = new Date("2026-10-15T05:05:10Z");
    expect(logsDue(slot, null)).toBe(true);
    expect(logsDue(new Date("2026-10-15T05:06:10Z"), null)).toBe(false);
    expect(logsDue(new Date("2026-10-15T05:06:10Z"), slot.getTime())).toBe(false);
    expect(logsDue(new Date("2026-10-15T05:10:05Z"), slot.getTime())).toBe(true);
    expect(logsDue(new Date("2026-10-15T05:16:10Z"), slot.getTime())).toBe(true); // the slot's minute was missed
  });
});
