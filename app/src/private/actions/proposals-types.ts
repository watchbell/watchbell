// Stage 9 slice 1 (owner 15 Oct): Ops agents propose, the owner approves (Stage 2). A room's officer in Kantor Virtual
// proposes one of the console's EXISTING actions for a firing alert; the owner approves or rejects it in the office (or
// follows the Telegram link there). Approval is the spec §12 confirmation, so an approved action runs through the same
// code, guards and audit trail as the console button. Safe, idempotent actions may run without asking, but only for the
// action kinds the owner switched on (office auto-run setting, all off by default). Risky ones always wait.
//
// This file is the shared contract of the slice: the database layer + API (proposals-db.ts, proposals-run.ts, the
// routes), the Telegram notice and the auto-run setting (proposals-notify.ts, proposals-settings.ts) and the office page
// (public/office/kantor-virtual.html) all use these names and shapes. Pure: no imports with side effects.
import type { ActionArea } from "./areas";

// The actions an officer may propose. Each maps to an existing console action (see ACTIONS[kind].uses).
export type ProposalAction =
  | "recheck"            // run the monitor's check now (monitor-actions checkNow) — safe
  | "neon_wake"          // wake a suspended Neon compute (Stage 6) — safe
  | "supabase_keepalive" // one keep-alive query for a Supabase project at auto-pause risk (Stage 6 Keep active) — safe
  | "supabase_restore"   // restore a paused Supabase project (Stage 6) — risky
  | "vercel_redeploy"    // redeploy the current production deployment (vercel-actions redeployAction) — risky
  | "vercel_rollback"    // roll production back to the previous ready deployment (vercel-actions rollbackAction) — risky
  | "github_bump_pr"     // Stage 9 slice 5: a branch + PR raising vulnerable packages to their fix (lib/data/deps-pr.ts) — risky
  | "daily_rerun"        // owner 19 Oct: call the console's own /api/daily again when its daily-job heartbeat is down (approval only) — risky
  | "domain_recheck"     // owner 17 Oct: a TLS handshake + RDAP read for a domain whose certificate looks close to expiry (Domains → Re-check) — safe
  | "monitor_update_url"; // Watchbell 1.2.1: point an uptime monitor at its app's new domain, keeping the path (Uptime → Update monitor) — safe

export type ProposalRisk = "safe" | "risky";
export type ProposalStatus = "pending" | "approved" | "running" | "done" | "failed" | "rejected" | "expired";

export const ACTIONS: Record<ProposalAction, { risk: ProposalRisk; label: string; uses: string }> = {
  recheck: { risk: "safe", label: "Check again now", uses: "monitor-actions checkNow" },
  neon_wake: { risk: "safe", label: "Wake Neon", uses: "Stage 6 Neon wake" },
  supabase_keepalive: { risk: "safe", label: "Send Supabase keep-alive", uses: "Stage 6 Keep active" },
  supabase_restore: { risk: "risky", label: "Restore Supabase project", uses: "Stage 6 Supabase restore" },
  vercel_redeploy: { risk: "risky", label: "Redeploy production", uses: "vercel-actions redeployAction" },
  vercel_rollback: { risk: "risky", label: "Roll back to previous deployment", uses: "vercel-actions rollbackAction" },
  github_bump_pr: { risk: "risky", label: "Open package update PR", uses: "lib/data/deps-pr.ts bumpPrAs (GitHub PR-write token)" },
  domain_recheck: { risk: "safe", label: "Re-check domain certificate", uses: "domains actions recheck (network-db recheckDomain)" },
  daily_rerun: { risk: "risky", label: "Rerun daily job", uses: "GET /api/daily with the cron secret (collector runDailyAll)" },
  monitor_update_url: { risk: "safe", label: "Update monitor", uses: "Uptime Update monitor (monitor-move-db moveMonitorToDomain)" },
};

// What the office and the API see. No emails, no secrets, no provider ids beyond what the console already shows.
export type Proposal = {
  id: string;
  room: ActionArea;
  action: ProposalAction;
  actionLabel: string;       // ACTIONS[action].label
  risk: ProposalRisk;
  title: string;             // e.g. "Redeploy production shortly" (display names / db-a aliases, never emails)
  reason: string;            // one short sentence: why (from the alert), max 200 chars
  resourceName: string | null;
  proposedBy: string;        // the officer's room label, e.g. "Workloads officer"
  status: ProposalStatus;
  auto: boolean;             // ran without asking (auto-run switched on for this kind)
  result: string | null;     // one short sentence after it ran / failed, max 200 chars
  createdAt: string;         // ISO
  decidedAt: string | null;  // ISO
  expiresAt: string;         // ISO; a pending proposal expires after PROPOSAL_TTL_MS or when its alert resolves
};

export type AutoRun = Record<ProposalAction, boolean>; // risky kinds are always false (enforced on write and on read)

export const PROPOSAL_TTL_MS = 2 * 3_600_000;

// API (owner session only, same as /api/office/reports; POST needs same-origin + header "X-Office-Ask: 1"):
//   GET  /api/office/proposals?limit=20      -> { proposals: Proposal[] (pending first, then newest), autoRun: AutoRun }
//   POST /api/office/proposals/{id}/decide   body { decision: "approve" | "reject" } -> { proposal: Proposal }
//        approve on a pending proposal runs it (status approved -> running -> done | failed); anything else -> 409
// The office derives the URL from its ask URL: ASK.url.replace(/ask$/, "proposals").
export type DecideBody = { decision: "approve" | "reject" };
