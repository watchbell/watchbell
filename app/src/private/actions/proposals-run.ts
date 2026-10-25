import "server-only";
import type { ActionResult } from "@/lib/action";
import { desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { collectorRuns } from "@/db/schema";
import { collectorEnv } from "@/lib/collector/env";
import { serverEnv } from "@/lib/env";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { bumpPrAs } from "@/lib/data/deps-pr";
import { keepAliveNow } from "@/lib/data/keep-active-db";
import { checkMonitorNow } from "@/lib/data/monitors-db";
import { moveMonitorToDomain } from "@/lib/data/monitor-move-db";
import { recheckDomain } from "@/lib/data/network-db";
import { wakeAs } from "@/lib/data/neon-wake";
import { type Actor, finish, type Finisher } from "@/lib/data/provider-action-db";
import { supabaseAct } from "@/lib/data/supabase-action";
import { redeployAs, rollbackAs } from "@/lib/data/vercel-action";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { SIMULATED_NOTE } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import { AUTO_ACTOR, AUTO_AUDIT_PREFIX } from "./proposals";
import { readAutoSecurity } from "./proposals-settings";
import { ACTIONS, type ProposalAction } from "./proposals-types";

// Stage 9 slice 1: run an approved proposal through the SAME server code as the console button (lib/data/*: the quota,
// the fresh read of the live state, the stale-target and idempotency guards, the write and its audit row). Approval is
// the spec §12 confirmation. The actor is the owner who approved (their quota, their name on the audit row), or the
// office auto-run (quota key "office-auto", no actor on the audit row, message prefixed "Office auto-run: "). Outside a
// server action nothing is refreshed. Never throws: an unexpected error is a failed result.

// ruleKey: the proposal's alert rule (Watchbell 1.2: a github_bump_pr of FrameworkVulnerable updates Next.js).
export type RunTarget = { action: ProposalAction; resourceId: string | null; targetRef: string | null; proposalId?: string | null; ruleKey?: string | null };
export type Runner = { member: { id: string; userId: string } | "auto" };

export type RunDeps = {
  checkMonitorNow: typeof checkMonitorNow; keepAliveNow: typeof keepAliveNow; wakeAs: typeof wakeAs; supabaseAct: typeof supabaseAct;
  redeployAs: typeof redeployAs; rollbackAs: typeof rollbackAs; finish: typeof finish; recordAction: typeof recordAction; limit: typeof limit;
  bumpPrAs?: typeof bumpPrAs;
  autoSecurity?: typeof readAutoSecurity;
  recheckDomain?: typeof recheckDomain;
  moveMonitorToDomain?: typeof moveMonitorToDomain;
  lastDailyRunAt?: () => Promise<Date | null>;
  fetch?: typeof fetch;
  dailyTarget?: () => { url: string; secret: string } | null;
  now?: () => Date;
};
const DEPS: RunDeps = {
  checkMonitorNow, keepAliveNow, wakeAs, supabaseAct, redeployAs, rollbackAs, finish, recordAction, limit, bumpPrAs, autoSecurity: () => readAutoSecurity(), recheckDomain, moveMonitorToDomain,
};

// Owner 19 Oct: the console's daily job (/api/daily, trigger vercel_cron) is not run twice within this time.
export const DAILY_COOLDOWN_MS = 6 * 3_600_000;
// The approval runs inside a 60 s function (Telegram callback), so the self-call is cut at 40 s: /api/daily is its own
// invocation and keeps running, and finishProposal must still get its turn.
const DAILY_TIMEOUT_MS = 40_000;

// When the last daily run started (a run that is still going counts: its task list is only written at the end).
async function lastDailyRunAt(): Promise<Date | null> {
  const [r] = await db().select({ at: collectorRuns.startedAt }).from(collectorRuns)
    .where(sql`(${collectorRuns.trigger} = 'vercel_cron' or (${collectorRuns.trigger} = 'manual' and ${collectorRuns.tasks} ? 'rollups'))`)
    .orderBy(desc(collectorRuns.startedAt)).limit(1);
  return r?.at ?? null;
}

function dailyTarget(): { url: string; secret: string } | null {
  const env = collectorEnv();
  return env ? { url: `${serverEnv().SITE_URL.replace(/\/+$/, "")}/api/daily`, secret: env.CRON_SECRET } : null;
}

async function rerunDaily(deps: RunDeps): Promise<ActionResult> {
  const last = await (deps.lastDailyRunAt ?? lastDailyRunAt)();
  const now = (deps.now ?? (() => new Date()))();
  if (last && now.getTime() - last.getTime() < DAILY_COOLDOWN_MS) return { ok: false, error: "The daily job ran less than 6 hours ago." };
  const target = (deps.dailyTarget ?? dailyTarget)();
  if (!target) return { ok: false, error: "The scheduler settings are missing, so the daily job can't be started." };
  try {
    const res = await (deps.fetch ?? fetch)(target.url, {
      headers: { Authorization: `Bearer ${target.secret}` }, signal: AbortSignal.timeout(DAILY_TIMEOUT_MS), redirect: "manual",
    });
    if (!res.ok || res.status >= 300) return { ok: false, error: `The daily job route answered ${res.status}.` };
    return { ok: true, message: `Daily job ran again (${res.status}).` };
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { ok: true, message: "Daily job started; it's still running — the heartbeat turns Up when it finishes." };
    throw e;
  }
}

const GONE = "The proposal's target is missing, so it can't run.";

export async function runProposalAction(t: RunTarget, who: Runner["member"], deps: RunDeps = DEPS): Promise<ActionResult> {
  const auto = who === "auto";
  const actor: Actor = auto ? { id: AUTO_ACTOR, userId: null } : { id: who.id, userId: who.userId };
  const fin: Finisher = (o, a, acc) => deps.finish(o, a, acc, { refresh: false, ...(auto ? { auditPrefix: AUTO_AUDIT_PREFIX } : {}) });
  try {
    if (!t.resourceId || !t.targetRef) return { ok: false, error: GONE };
    // Demo: every action but a re-check would reach a provider (or this server's own /api/daily), so it is simulated:
    // an audit entry in the visitor's database and a result that says so. A re-check runs (its check is simulated).
    if (isDemo() && t.action !== "recheck") {
      await deps.recordAction({ kind: "ok", message: `${auto ? AUTO_AUDIT_PREFIX : ""}${ACTIONS[t.action].label} (simulated)`, detail: "Simulated in the demo", resourceId: t.resourceId, actorUserId: actor.userId })
        .catch(() => console.warn("audit event failed"));
      return { ok: true, message: SIMULATED_NOTE };
    }
    switch (t.action) {
      case "recheck": {
        // monitor-actions checkNow, without the role check (the approval is the owner's): the check quota, then the check.
        const quota = await deps.limit(LIMITS.check, actor.id);
        if (!quota.allowed) return { ok: false, error: `Too many checks. Try again in ${minutesText(quota.retryAfter)}.` };
        const r = await deps.checkMonitorNow(t.targetRef);
        if (!r.ok) return { ok: false, error: r.error };
        if (r.audit) {
          try {
            await deps.recordAction({ kind: r.passed === false ? "err" : "ok", ...r.audit, message: `${auto ? AUTO_AUDIT_PREFIX : ""}${r.audit.message}`, actorUserId: actor.userId });
          } catch {
            console.warn("audit event failed");
          }
        }
        return { ok: true, message: r.message }; // the check ran; its message says whether it passed
      }
      // Owner 17 Oct: Domains → Re-check, without the role check (the approval or auto-run switch is the owner's).
      case "domain_recheck": {
        const quota = await deps.limit(LIMITS.domainCheck, actor.id);
        if (!quota.allowed) return { ok: false, error: `Too many checks. Try again in ${minutesText(quota.retryAfter)}.` };
        const r = await (deps.recheckDomain ?? recheckDomain)(t.targetRef);
        if (!r.ok) return r;
        await deps.recordAction({ kind: "ok", ...r.audit, message: `${auto ? AUTO_AUDIT_PREFIX : ""}${r.audit.message}`, actorUserId: actor.userId })
          .catch(() => console.warn("audit event failed"));
        return { ok: true, message: r.message };
      }
      // Watchbell 1.2.1: Uptime → Update monitor (the app moved to a new domain), under the same quota as the button.
      case "monitor_update_url": {
        const quota = await deps.limit(LIMITS.monitorWrite, actor.id);
        if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
        const r = await (deps.moveMonitorToDomain ?? moveMonitorToDomain)(t.targetRef);
        if (!r.ok) return r;
        if (r.audit) {
          await deps.recordAction({ kind: "ok", ...r.audit, message: `${auto ? AUTO_AUDIT_PREFIX : ""}${r.audit.message}`, actorUserId: actor.userId })
            .catch(() => console.warn("audit event failed"));
        }
        return { ok: true, message: r.message };
      }
      // Owner 19 Oct: approval only (never auto). The route runs with the cron secret, the same as Vercel Cron's call.
      case "daily_rerun": return await rerunDaily(deps);
      case "neon_wake": return await deps.wakeAs(actor, t.resourceId, t.targetRef, fin);
      case "supabase_keepalive": return await deps.keepAliveNow(actor, t.resourceId, fin);
      case "supabase_restore": return await deps.supabaseAct("restore", actor, t.resourceId, t.targetRef, fin);
      case "vercel_redeploy": return await deps.redeployAs(actor, t.resourceId, t.targetRef, fin);
      case "vercel_rollback": return await deps.rollbackAs(actor, t.resourceId, t.targetRef, fin);
      // Stage 9 slice 5: the app (resourceId) and its linked repository (targetRef). Auto-run only through "Automatic
      // security fixes": then the PR carries only the upgrades that policy allows (bumpPrAs refuses otherwise).
      case "github_bump_pr": {
        const security = auto ? await (deps.autoSecurity ?? readAutoSecurity)() : null;
        if (auto && !security?.enabled) return { ok: false, error: "Automatic security fixes is off." };
        return await (deps.bumpPrAs ?? bumpPrAs)(actor, t.resourceId, t.targetRef, fin, {
          proposalId: t.proposalId ?? null, ...(security ? { auto: { severities: security.severities } } : {}),
          ...(t.ruleKey === "FrameworkVulnerable" ? { framework: true } : {}),
        });
      }
      default: return { ok: false, error: GONE };
    }
  } catch (e) {
    console.warn(`${ACTIONS_COPY.logTag}/proposals run failed:`, e instanceof Error ? e.name : "error");
    return { ok: false, error: "Something went wrong while running it. Check the console page before trying again." };
  }
}
