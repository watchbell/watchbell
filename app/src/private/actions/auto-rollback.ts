import { clip } from "./proposals";
import type { NextStatus } from "./rollback-guard";

// Auto-rollback after a bad production deploy (owner 16 Oct). Pure. A vercel_rollback proposal runs without asking (as
// "office-auto", through the same run path and guards as an approval) only when ALL of these hold:
//   - the owner switched it on (Settings › Office auto-run › Auto-rollback);
//   - the proposal came from a down monitor (MonitorDown) or an error spike in the logs (LogErrorSpike);
//   - the live production deployment went live at most windowMin minutes ago, and the proposal still targets the
//     previous production deployment of that live one;
//   - the live deployment is the newest production deployment (not a rolled-back state) and isn't itself the result of
//     a rollback or a promote (no such console action on the app in the last 2 hours);
//   - the previous deployment is READY and at most 30 days old, and its Next.js is known to have no advisories
//     (Watchbell 1.2.2, rollback-guard.ts previousNext: a vulnerable or unknown one waits for the owner);
//   - no auto-rollback of this app in the last 2 hours, none ever for this same deployment pair, and no other
//     auto-rollback in flight anywhere.
// Failed builds never go live on Vercel; this is for builds that succeed but break at runtime.

export const AUTO_ROLLBACK_RULES = new Set(["MonitorDown", "LogErrorSpike"]);
export const AUTO_ROLLBACK_GAP_MS = 2 * 3_600_000;
export const PREVIOUS_MAX_AGE_MS = 30 * 86_400_000;

export type RollbackDeploy = {
  currentId: string; currentSha: string | null; liveAt: Date | null; currentCreatedAt: Date; newestProdCreatedAt: Date | null;
  previousId: string | null; previousState: string | null; previousCreatedAt: Date | null;
};

export type RollbackCheck = {
  setting: { enabled: boolean; windowMin: number };
  ruleKey: string | null;
  targetRef: string | null;
  deploy: RollbackDeploy | null;
  rolledOrPromotedLately: boolean; // a console rollback / promote of this app in the last 2 h
  autoLately: boolean;             // an auto-rollback of this app in the last 2 h
  sameDeployBefore: boolean;       // an auto-rollback to this same previous deployment, ever (retention: 30 days)
  inFlight: boolean;               // an auto-rollback approved or running anywhere
  previousNext: NextStatus;        // the previous deployment's Next.js: only "ok" may run alone
};

export type RollbackDecision = { ok: true } | { ok: false; why: string };

export function autoRollbackDecision(c: RollbackCheck, now: Date): RollbackDecision {
  const no = (why: string): RollbackDecision => ({ ok: false, why });
  if (!c.setting.enabled) return no("off");
  if (!c.ruleKey || !AUTO_ROLLBACK_RULES.has(c.ruleKey)) return no("rule");
  const d = c.deploy;
  if (!d || !d.liveAt) return no("no live deploy");
  const age = now.getTime() - d.liveAt.getTime();
  if (age < 0 || age > c.setting.windowMin * 60_000) return no("outside the window");
  if (!d.previousId || c.targetRef !== d.previousId || d.previousId === d.currentId) return no("target changed");
  if (d.newestProdCreatedAt && d.currentCreatedAt.getTime() < d.newestProdCreatedAt.getTime()) return no("live deploy is a rollback");
  if (c.rolledOrPromotedLately) return no("live deploy came from a rollback or promote");
  if ((d.previousState ?? "").toLowerCase() !== "ready") return no("previous not ready");
  if (!d.previousCreatedAt || now.getTime() - d.previousCreatedAt.getTime() > PREVIOUS_MAX_AGE_MS) return no("previous too old");
  if (c.previousNext === "vulnerable") return no("previous Next.js has advisories");
  if (c.previousNext !== "ok") return no("previous Next.js unknown");
  if (c.autoLately) return no("auto-rollback within 2 h");
  if (c.sameDeployBefore) return no("already rolled back once");
  if (c.inFlight) return no("another auto-rollback is running");
  return { ok: true };
}

// The new deployment as the owner knows it: its short commit, else its id.
export const deployRef = (d: { currentSha: string | null; currentId: string }): string =>
  d.currentSha && /^[0-9a-f]{7,40}$/i.test(d.currentSha) ? d.currentSha.slice(0, 7) : d.currentId.slice(0, 16);

// The reason the office shows on the auto-run proposal (≤ 200).
export const autoRollbackReason = (ref: string, windowMin: number, reason: string): string =>
  clip(`Automatic: the new deploy ${ref} errored in the first ${windowMin} minutes. ${reason}`);
