import type { AliasBook } from "@/lib/view/display-name";
import { cleanLine } from "@/private/console/clean-text";
import type { ActionArea } from "./areas";
import { clip, type ProposalDraft, proposalTitle, proposedBy, shownName, TEXT_MAX } from "./proposals";
import { ACTIONS, PROPOSAL_TTL_MS, type ProposalAction } from "./proposals-types";
import { type PreviousNext, UNKNOWN_NOTE } from "./rollback-guard";

// Stage 9 (owner 15 Oct): officers read the stored logs (ops.stored_logs: warning / error / fatal lines of the watched
// apps) and propose console actions through the same proposals flow as the firing alerts. Pure. Three rules:
//   LogErrorSpike (Workloads): the app's live production deployment went live < 2 h ago and the errors since then are
//     ≥ max(10, 5 × the hourly error rate of the 24 h before it) → vercel_rollback (risky), only with a previous ready
//     production deployment (the same target as the DeploymentFailed path: is_current / is_previous_production).
//     Watchbell 1.2.2 (D17): not when that deployment's Next.js has known advisories; an unknown one is proposed with
//     that said first in its reason (and never auto-runs: auto-rollback.ts).
//   LogErrors (Workloads): ≥ 20 errors in the last 30 min and no production deploy in the last 2 h → recheck (safe) of
//     the app's HTTP monitor, when it has one.
//   LogDbErrors (Databases): ≥ 3 lines in the last 30 min that read like a database connection problem, for an app with a
//     linked database (uses_db) → neon_wake (safe) when it is a Neon compute that can be woken, supabase_restore (risky)
//     when it is a paused Supabase project, nothing otherwise.
// An error is a line of level error / fatal, or any stored line with a 5xx status. Log proposals carry no alert; they
// are deduped by (rule, resource, action) in proposals-db.ts and expire when their condition stops holding.

export const LOG_RULES = ["LogErrorSpike", "LogErrors", "LogDbErrors"] as const;
export type LogRule = (typeof LOG_RULES)[number];
export const isLogRule = (v: string): v is LogRule => (LOG_RULES as readonly string[]).includes(v);

export const SPIKE_WINDOW_MS = 2 * 3_600_000; // the deploy went live less than this ago
export const SPIKE_MIN = 10;
export const SPIKE_FACTOR = 5;
export const BASELINE_MS = 24 * 3_600_000;
export const RECENT_MS = 30 * 60_000;
export const ERRORS_MIN = 20;
export const NO_DEPLOY_MS = 2 * 3_600_000;
export const DB_ERRORS_MIN = 3;
export const COOLDOWN_MS = 2 * 3_600_000; // a closed log proposal blocks the same one for this long
export const LOG_EVERY_MS = 5 * 60_000; // logs are read at most this often
// The same pattern in SQL (proposals-db.ts reads the counts with it): keep the two in step.
export const DB_ERROR_SQL = "timeout|ECONNREFUSED|too many connections|terminating connection|connection terminated|endpoint is disabled|compute.*suspend";
export const DB_ERROR = new RegExp(DB_ERROR_SQL, "i");

// One app's log counts and context, from proposals-db.ts's aggregate reads.
export type LogApp = {
  appId: string; appName: string;
  liveAt: Date | null; // when the live production deployment went live (ready_at, else created)
  currentId: string | null; previousId: string | null; lastDeployAt: Date | null; // newest production deployment
  errorsSinceLive: number; baselineErrors: number; topSinceLive: string | null; // baseline: the 24 h before liveAt
  errors30: number; top30: string | null;
  dbErrors30: number; topDb: string | null;
  httpMonitorId: string | null;
  db: { resourceId: string; kind: string; wakeEndpoint: string | null; supabaseRef: string | null; supabasePaused: boolean } | null;
  previousNext?: PreviousNext; // the previous production deployment's Next.js (read only for a spike; missing: unknown)
};

export type LogDraft = Omit<ProposalDraft, "alertId"> & { alertId: null; ruleKey: LogRule };

const DPL = /^dpl_[A-Za-z0-9]{8,40}$/;
const EP = /^ep-[a-z0-9-]{3,60}$/;
const REF = /^[a-z0-9]{8,40}$/;

export const spikeThreshold = (baselineErrors: number): number => Math.max(SPIKE_MIN, Math.ceil((SPIKE_FACTOR * baselineErrors) / 24));

// "<counts>. Most common: <message>." scrubbed (aliases, no hosts or emails), ≤ 200.
export function logReason(counts: string, top: string | null, book: AliasBook): string {
  const msg = top ? cleanLine(top, book, 120) : "";
  return clip(cleanLine(msg ? `${counts}. Most common: ${msg}` : counts, book, TEXT_MAX) || counts, TEXT_MAX);
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

type Pick1 = { ruleKey: LogRule; room: ActionArea; action: ProposalAction; resourceKind: string; resourceId: string; targetRef: string; reason: string };

export function logPicks(a: LogApp, book: AliasBook, now: Date): Pick1[] {
  const out: Pick1[] = [];
  const t = now.getTime();
  const recentLive = a.liveAt !== null && t - a.liveAt.getTime() < SPIKE_WINDOW_MS && a.liveAt.getTime() <= t;
  const prev = a.previousNext?.status ?? "unknown";
  if (recentLive && a.errorsSinceLive >= spikeThreshold(a.baselineErrors) && a.currentId && a.previousId && DPL.test(a.previousId) && a.previousId !== a.currentId && prev !== "vulnerable") {
    const counts = `${a.errorsSinceLive} errors since the deploy went live ${minutes(t - a.liveAt!.getTime())} min ago (${a.baselineErrors} in the 24 h before)`;
    const reason = logReason(counts, a.topSinceLive, book);
    out.push({ ruleKey: "LogErrorSpike", room: "workloads", action: "vercel_rollback", resourceKind: "app", resourceId: a.appId, targetRef: a.previousId, reason: prev === "ok" ? reason : clip(`${UNKNOWN_NOTE} ${reason}`) });
  }
  const deployedLately = a.lastDeployAt !== null && t - a.lastDeployAt.getTime() < NO_DEPLOY_MS;
  if (a.errors30 >= ERRORS_MIN && !deployedLately && a.httpMonitorId) {
    out.push({ ruleKey: "LogErrors", room: "workloads", action: "recheck", resourceKind: "app", resourceId: a.appId, targetRef: a.httpMonitorId, reason: logReason(`${a.errors30} errors in the last 30 min`, a.top30, book) });
  }
  if (a.dbErrors30 >= DB_ERRORS_MIN && a.db) {
    const reason = logReason(`${a.dbErrors30} database connection errors in the last 30 min`, a.topDb, book);
    const d = a.db;
    if ((d.kind === "neon_project" || d.kind === "neon_branch") && d.wakeEndpoint && EP.test(d.wakeEndpoint)) {
      out.push({ ruleKey: "LogDbErrors", room: "databases", action: "neon_wake", resourceKind: d.kind, resourceId: d.resourceId, targetRef: d.wakeEndpoint, reason });
    } else if (d.kind === "supabase_project" && d.supabasePaused && d.supabaseRef && REF.test(d.supabaseRef)) {
      out.push({ ruleKey: "LogDbErrors", room: "databases", action: "supabase_restore", resourceKind: d.kind, resourceId: d.resourceId, targetRef: d.supabaseRef, reason });
    }
  }
  return out;
}

export function logProposalsFor(a: LogApp, book: AliasBook, now: Date): LogDraft[] {
  return logPicks(a, book, now).map((p) => {
    const name = p.resourceKind === "app" ? shownName("app", a.appId, a.appName, book) : shownName(p.resourceKind, p.resourceId, null, book);
    return {
      alertId: null, ruleKey: p.ruleKey, room: p.room, action: p.action, risk: ACTIONS[p.action].risk, title: proposalTitle(p.action, name), reason: p.reason,
      resourceKind: p.resourceKind, resourceId: p.resourceId, resourceName: name, targetRef: p.targetRef, proposedBy: proposedBy(p.room),
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    };
  });
}

// The dedupe / condition key of a log proposal.
export const logKey = (p: { ruleKey: string; resourceId: string | null; action: string }): string => `${p.ruleKey}:${p.resourceId ?? ""}:${p.action}`;

export type LogRow = { id: string; ruleKey: string; resourceId: string | null; action: string; status: string; closedAt: Date | null };
const OPEN = new Set(["pending", "approved", "running"]);

// Drafts that may be inserted: no open proposal with the same key, and none closed less than COOLDOWN_MS ago.
export function freshLogDrafts(drafts: LogDraft[], existing: LogRow[], now: Date): LogDraft[] {
  const blocked = new Set(existing.filter((r) => OPEN.has(r.status) || (r.closedAt !== null && now.getTime() - r.closedAt.getTime() < COOLDOWN_MS)).map(logKey));
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const k = logKey(d);
    if (blocked.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Pending log proposals whose condition no longer holds (not among this evaluation's drafts) → their ids.
export function staleLogIds(existing: LogRow[], holding: LogDraft[]): string[] {
  const keys = new Set(holding.map(logKey));
  return existing.filter((r) => r.status === "pending" && isLogRule(r.ruleKey) && !keys.has(logKey(r))).map((r) => r.id);
}

// Whether the minute run reads the logs this time: once per 5-minute slot. `last` is this instance's last read (a
// module-level memo); a cold instance reads only in the slot's first minute, so instances don't pile up.
export function logsDue(now: Date, last: number | null): boolean {
  const t = now.getTime();
  if (last !== null && t - last < LOG_EVERY_MS - 30_000) return false;
  return Math.floor(t / 60_000) % 5 === 0 || (last !== null && t - last >= LOG_EVERY_MS * 2);
}

export const isDbErrorLine = (message: string): boolean => DB_ERROR.test(message);
