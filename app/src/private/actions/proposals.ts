import { type AliasBook, appAlias, dbAlias, hideAlert } from "@/lib/view/display-name";
import { areaForAlert, type ActionArea, proposedBy } from "./areas";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { cleanLine } from "@/private/console/clean-text";
import { ACTIONS, type AutoRun, type DecideBody, type Proposal, type ProposalAction, PROPOSAL_TTL_MS, type ProposalStatus } from "./proposals-types";

// Stage 9 slice 1 (owner 15 Oct): which existing console action an officer proposes for a firing alert, and how a
// proposal reads in the office. Pure. Which alert gets what:
//   DeploymentFailed (an app)        → vercel_redeploy of the live production deployment, plus vercel_rollback when a
//                                      previous ready production deployment exists
//   DatabasePaused (Supabase)        → supabase_restore
//   AutoPauseRisk (Supabase)         → supabase_keepalive
//   VulnerableDependency (an app)    → github_bump_pr (Stage 9 slice 5), when a direct package of the app's linked
//                                      repository has a known fixed version (the target is the repository id)
//   MonitorDown / HighLatency (HTTP) → recheck (a heartbeat can't be checked from here); and neon_wake when the app's
//                                      linked database (uses_db) is a Neon compute that is suspended and can be woken
//   anything else, or a silenced alert → nothing
// Text: display names / aliases as the office alarms show them (apps app-a, databases db-a), scrubbed, never an email,
// at most 200 characters. A pending proposal expires after PROPOSAL_TTL_MS, or as soon as its alert is no longer firing.

export const TEXT_MAX = 200;
export const AUTO_ACTOR = "office-auto"; // the auto-run's quota key and the name the audit gives it
export const AUTO_AUDIT_PREFIX = ACTIONS_COPY.auditPrefix;
export const RUN_STUCK_MS = 10 * 60_000; // a run that never finished (the process died) fails after this
export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 50;

// The listFiring columns this reads (FiringRow).
export type ProposalAlert = {
  id: string; ruleKey: string; subject: string; severity: "critical" | "warning" | "info"; title: string; message: string;
  resourceId: string | null; resourceKind: string | null; resourceName: string | null; causedBy: string | null;
  silencedUntil: Date | null; silencedUntilResolved: boolean;
  // An account alert's account (CredentialExpiring), so a paused section's credential gets no proposal (Watchbell 1.2).
  accountId?: string | null;
};

export type SuspendedNeon = { resourceId: string; resourceKind: "neon_project" | "neon_branch"; endpointId: string };

// What the database layer read for these alerts (only what they need).
export type ProposalFacts = {
  monitorKinds: ReadonlyMap<string, string>; // monitor id → "http" | "heartbeat"
  deploys: ReadonlyMap<string, { currentId: string | null; previousId: string | null; liveAt?: Date | null }>; // app id → its production deployments (liveAt: when the current one went live)
  rollbackWindowMs?: number; // auto-rollback setting's window: a down / slow app's new deploy younger than this gets a rollback proposal
  supabaseRefs: ReadonlyMap<string, string>; // supabase_project resource id → ref
  neonSuspended: ReadonlyMap<string, SuspendedNeon>; // app id → its linked, suspended Neon compute
  dailyHeartbeatId?: string | null; // owner 19 Oct: the monitor id of the console's own daily-job heartbeat (DAILY_HEARTBEAT_TOKEN), null when not set up
  fixableRepos?: ReadonlyMap<string, string>; // Stage 9 slice 5: app id → its linked repository, when an update PR can fix something
};

export type ProposalDraft = {
  alertId: string; ruleKey: string; room: ActionArea; action: ProposalAction; risk: Proposal["risk"]; title: string; reason: string;
  resourceKind: string | null; resourceId: string | null; resourceName: string | null; targetRef: string | null; proposedBy: string;
  expiresAt: Date;
};

const DPL = /^dpl_[A-Za-z0-9]{8,40}$/;
const EP = /^ep-[a-z0-9-]{3,60}$/;
const REF = /^[a-z0-9]{8,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const clip = (s: string, max = TEXT_MAX): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const end = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const isDb = (kind: string | null) => kind === "supabase_project" || kind === "neon_project" || kind === "neon_branch" || kind === "firestore";

export { proposedBy };

// The name the office shows for a resource: an app's alias, a database's alias, else the scrubbed name.
export function shownName(kind: string | null, id: string | null, name: string | null, book: AliasBook): string | null {
  if (kind === "app" && name) return appAlias(book, name);
  if (isDb(kind) && id) return dbAlias(book, id);
  return name ? cleanLine(name, book, 120) || null : null;
}

const TITLES: Record<ProposalAction, (name: string) => string> = {
  recheck: (n) => `Check ${n} again now`,
  neon_wake: (n) => `Wake the Neon compute of ${n}`,
  supabase_keepalive: (n) => `Send a keep-alive to ${n}`,
  supabase_restore: (n) => `Restore Supabase project ${n}`,
  vercel_redeploy: (n) => `Redeploy production ${n}`,
  vercel_rollback: (n) => `Roll ${n} back to the previous deployment`,
  github_bump_pr: (n) => `Open a PR updating vulnerable packages in ${n}`,
  domain_recheck: (n) => `Re-check the certificate of ${n}`,
  daily_rerun: () => "Rerun the daily job",
};

export const proposalTitle = (action: ProposalAction, name: string | null): string => clip(TITLES[action](name ?? "this resource"));

// One sentence from the alert: its (aliased) title and message.
export function proposalReason(a: ProposalAlert, book: AliasBook): string {
  const shown = hideAlert(a, book);
  const title = cleanLine(shown.title, book, 80);
  const msg = cleanLine(shown.message, book, TEXT_MAX);
  const text = [title && end(title), msg && end(msg)].filter(Boolean).join(" ") || `${a.ruleKey}.`;
  return clip(text);
}

const silenced = (a: ProposalAlert, now: Date) => a.silencedUntilResolved || (a.silencedUntil !== null && a.silencedUntil.getTime() > now.getTime());

type Pick1 = { action: ProposalAction; room?: ActionArea; resourceKind: string | null; resourceId: string | null; targetRef: string };

// A new production deploy younger than the window, with a previous ready deployment to go back to (auto-rollback rule).
export function freshDeploy(d: { currentId: string | null; previousId: string | null; liveAt?: Date | null } | undefined, windowMs: number, now: Date): boolean {
  if (!d?.currentId || !d.previousId || !d.liveAt || !DPL.test(d.previousId) || d.previousId === d.currentId) return false;
  const age = now.getTime() - d.liveAt.getTime();
  return age >= 0 && age <= windowMs;
}

function picks(a: ProposalAlert, f: ProposalFacts, now: Date): Pick1[] {
  const app = a.resourceKind === "app" && a.resourceId ? a.resourceId : null;
  switch (a.ruleKey) {
    case "DeploymentFailed": {
      const d = app ? f.deploys.get(app) : undefined;
      if (!app || !d?.currentId || !DPL.test(d.currentId)) return [];
      const out: Pick1[] = [{ action: "vercel_redeploy", resourceKind: "app", resourceId: app, targetRef: d.currentId }];
      if (d.previousId && DPL.test(d.previousId) && d.previousId !== d.currentId) out.push({ action: "vercel_rollback", resourceKind: "app", resourceId: app, targetRef: d.previousId });
      return out;
    }
    case "DatabasePaused": case "AutoPauseRisk": {
      if (a.resourceKind !== "supabase_project" || !a.resourceId) return [];
      const ref = f.supabaseRefs.get(a.resourceId);
      if (!ref || !REF.test(ref)) return [];
      return [{ action: a.ruleKey === "DatabasePaused" ? "supabase_restore" : "supabase_keepalive", resourceKind: "supabase_project", resourceId: a.resourceId, targetRef: ref }];
    }
    case "VulnerableDependency": {
      const repo = app ? f.fixableRepos?.get(app) : undefined;
      return app && repo && UUID.test(repo) ? [{ action: "github_bump_pr", resourceKind: "app", resourceId: app, targetRef: repo }] : [];
    }
    case "MonitorDown": case "HighLatency": {
      const out: Pick1[] = [];
      if (app && UUID.test(a.subject) && f.monitorKinds.get(a.subject) === "http") out.push({ action: "recheck", resourceKind: "app", resourceId: app, targetRef: a.subject });
      // Owner 19 Oct: the console's own daily job missed its heartbeat → propose running it again (approval only).
      if (a.ruleKey === "MonitorDown" && a.resourceId && UUID.test(a.subject) && f.dailyHeartbeatId === a.subject) {
        out.push({ action: "daily_rerun", room: "observe", resourceKind: a.resourceKind, resourceId: a.resourceId, targetRef: a.subject });
      }
      const neon = app ? f.neonSuspended.get(app) : undefined;
      if (neon && EP.test(neon.endpointId)) out.push({ action: "neon_wake", room: "databases", resourceKind: neon.resourceKind, resourceId: neon.resourceId, targetRef: neon.endpointId });
      // Auto-rollback rule (owner 16 Oct): the app broke within the first minutes of a new production deploy.
      const d = app ? f.deploys.get(app) : undefined;
      if (app && freshDeploy(d, f.rollbackWindowMs ?? ROLLBACK_WINDOW_MS_DEFAULT, now)) {
        out.push({ action: "vercel_rollback", resourceKind: "app", resourceId: app, targetRef: d!.previousId! });
      } else if (a.ruleKey === "MonitorDown" && app && d?.currentId && DPL.test(d.currentId) && f.monitorKinds.get(a.subject) === "http") {
        // Owner 17 Oct: a site that stays down outside that window gets the risky fixes too, waiting for the owner's
        // approval (Telegram buttons). The auto-rollback rule refuses them outside its window, so neither runs alone.
        out.push({ action: "vercel_redeploy", resourceKind: "app", resourceId: app, targetRef: d.currentId });
        if (d.previousId && DPL.test(d.previousId) && d.previousId !== d.currentId) out.push({ action: "vercel_rollback", resourceKind: "app", resourceId: app, targetRef: d.previousId });
      }
      return out;
    }
    // Owner 17 Oct: a certificate close to expiry is usually renewed already (Vercel, Caddy) and the console's copy is
    // stale; a re-check reads the live one.
    case "CertExpiringSoon":
      return a.resourceKind === "domain" && a.resourceId && UUID.test(a.resourceId)
        ? [{ action: "domain_recheck", resourceKind: "domain", resourceId: a.resourceId, targetRef: a.resourceId }] : [];
    default:
      return [];
  }
}

export const ROLLBACK_WINDOW_MS_DEFAULT = 30 * 60_000;

// github_bump_pr reason: "Vulnerable packages in app-t have a fix: a 1.0 → 1.1."
export function bumpReason(a: ProposalAlert, name: string | null, book: AliasBook): string {
  const msg = cleanLine(hideAlert(a, book).message, book, TEXT_MAX);
  const list = msg.includes(": ") ? msg.slice(msg.indexOf(": ") + 2) : "";
  const head = `Vulnerable packages in ${name ?? "this app"} have a fix`;
  return clip(list ? `${head}: ${list}` : `${head}.`);
}

// The proposals for one alert (none for a silenced one).
export function proposalsFor(a: ProposalAlert, f: ProposalFacts, book: AliasBook, now: Date): ProposalDraft[] {
  if (silenced(a, now)) return [];
  const alertReason = proposalReason(a, book);
  return picks(a, f, now).map((p) => {
    const room = p.room ?? areaForAlert(a);
    // A Neon wake for an app's alert names the database, not the app.
    const name = p.action === "neon_wake" ? shownName(p.resourceKind, p.resourceId, null, book) : shownName(a.resourceKind, a.resourceId, a.resourceName, book);
    return {
      alertId: a.id, ruleKey: a.ruleKey, room, action: p.action, risk: ACTIONS[p.action].risk, title: proposalTitle(p.action, name),
      reason: p.action === "github_bump_pr" ? bumpReason(a, name, book) : alertReason,
      resourceKind: p.resourceKind, resourceId: p.resourceId, resourceName: name, targetRef: p.targetRef, proposedBy: proposedBy(room),
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    };
  });
}

// The alert kinds that need facts read: which monitors, apps and Supabase projects.
export function factNeeds(alerts: ProposalAlert[], now: Date): { monitorIds: string[]; deployApps: string[]; supabaseIds: string[]; monitorApps: string[]; depApps: string[] } {
  const live = alerts.filter((a) => !silenced(a, now));
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x && UUID.test(x)))];
  const monitorAlerts = live.filter((a) => (a.ruleKey === "MonitorDown" || a.ruleKey === "HighLatency") && a.resourceKind === "app");
  return {
    monitorIds: uniq(monitorAlerts.map((a) => a.subject)),
    monitorApps: uniq(monitorAlerts.map((a) => a.resourceId)),
    // DeploymentFailed, and the down / slow apps (auto-rollback rule: was the live deploy new?).
    deployApps: uniq(live.filter((a) => (a.ruleKey === "DeploymentFailed" || a.ruleKey === "MonitorDown" || a.ruleKey === "HighLatency") && a.resourceKind === "app").map((a) => a.resourceId)),
    supabaseIds: uniq(live.filter((a) => (a.ruleKey === "DatabasePaused" || a.ruleKey === "AutoPauseRisk") && a.resourceKind === "supabase_project").map((a) => a.resourceId)),
    depApps: uniq(live.filter((a) => a.ruleKey === "VulnerableDependency" && a.resourceKind === "app").map((a) => a.resourceId)),
  };
}

// A Neon compute that can be woken: suspended ("idle"), not disabled, not already starting.
export function wakeableEndpoint(
  endpoints: { id: string; branchId: string; state: string; pendingState: string | null; disabled: boolean }[] | undefined,
  branches: { id: string; isDefault: boolean }[] | undefined, branchExternalId: string | null,
): string | null {
  const branch = branchExternalId ?? branches?.find((b) => b.isDefault)?.id ?? null;
  const ep = (endpoints ?? []).find((e) => (branch ? e.branchId === branch : true));
  if (!ep || ep.disabled || ep.state !== "idle" || ep.pendingState === "active" || !EP.test(ep.id)) return null;
  return ep.id;
}

// Whether a pending proposal has expired now: past its time, or its alert no longer fires.
export function isExpired(p: { status: ProposalStatus; expiresAt: Date; alertId: string | null }, firing: ReadonlySet<string>, now: Date): boolean {
  if (p.status !== "pending") return false;
  return p.expiresAt.getTime() <= now.getTime() || (p.alertId !== null && !firing.has(p.alertId));
}

// Which of these new proposals run without asking: safe kinds the owner switched on. Risky kinds never do.
export const autoRuns = (action: ProposalAction, autoRun: AutoRun): boolean => ACTIONS[action].risk === "safe" && autoRun[action] === true;

// A stored row → the contract's Proposal.
export type ProposalRow = {
  id: string; room: ActionArea; action: ProposalAction; risk: Proposal["risk"]; title: string; reason: string; resourceName: string | null;
  proposedBy: string; status: ProposalStatus; auto: boolean; result: string | null; createdAt: Date; decidedAt: Date | null; expiresAt: Date;
};

export function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, room: r.room, action: r.action, actionLabel: ACTIONS[r.action].label, risk: ACTIONS[r.action].risk, title: r.title, reason: r.reason,
    resourceName: r.resourceName, proposedBy: r.proposedBy, status: r.status, auto: r.auto, result: r.result, createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, expiresAt: r.expiresAt.toISOString(),
  };
}

// A run's outcome as one scrubbed sentence (the action's own message names the real app or project).
export function resultSentence(r: { ok: true; message?: string } | { ok: false; error: string }, book: AliasBook): string {
  const text = r.ok ? r.message || "Done." : r.error || "It didn't run.";
  return clip(cleanLine(text, book, TEXT_MAX) || (r.ok ? "Done." : "It didn't run."));
}

// GET ?limit: 1–50, default 20.
export function parseProposalLimit(raw: string | null): number {
  const n = raw !== null && /^\d{1,4}$/.test(raw.trim()) ? Number(raw) : LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(1, n || LIMIT_DEFAULT));
}

// POST body (strict): { decision: "approve" | "reject" }.
export function parseDecideBody(body: unknown): { ok: true; data: DecideBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: 'Send {"decision": "approve"} or {"decision": "reject"}.' };
  const keys = Object.keys(body);
  const d = (body as Record<string, unknown>).decision;
  if (keys.length !== 1 || (d !== "approve" && d !== "reject")) return { ok: false, error: 'Send {"decision": "approve"} or {"decision": "reject"}.' };
  return { ok: true, data: { decision: d } };
}

export const isProposalId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
