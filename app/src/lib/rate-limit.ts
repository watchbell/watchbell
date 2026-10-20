import { createHash } from "node:crypto";

export type Limit = { name: string; max: number; windowSeconds: number };
export type HitFn = (key: string, windowStart: Date) => Promise<number>;
export type LimitDecision = { allowed: boolean; retryAfter: number };

export const LIMITS = {
  signinIp: { name: "signin-ip", max: 5, windowSeconds: 900 },
  signinEmail: { name: "signin-email", max: 3, windowSeconds: 900 },
  credential: { name: "credential", max: 20, windowSeconds: 600 },
  mfaCode: { name: "mfa-code", max: 5, windowSeconds: 300 },
  // Self-host first-run setup: failed one-time-code attempts per IP (when a trusted proxy names it) and in total.
  // A restart prints a new code and clears both (src/lib/local-auth/setup.ts).
  setupIp: { name: "setup-ip", max: 5, windowSeconds: 900 },
  setupAll: { name: "setup-all", max: 100, windowSeconds: 900 },
  sync: { name: "sync", max: 10, windowSeconds: 600 },
  refresh: { name: "refresh", max: 10, windowSeconds: 600 },
  check: { name: "check", max: 30, windowSeconds: 600 },
  monitorWrite: { name: "monitor-write", max: 60, windowSeconds: 600 },
  securityCheck: { name: "security-check", max: 10, windowSeconds: 600 },
  domainCheck: { name: "domain-check", max: 10, windowSeconds: 600 },
  logsLive: { name: "logs-live", max: 60, windowSeconds: 600 },
  alertWrite: { name: "alert-write", max: 60, windowSeconds: 600 },
  notifyTest: { name: "notify-test", max: 5, windowSeconds: 600 },
  // U3/B2: per heartbeat token (its hash), so a looping job can't turn into a write per request.
  ping: { name: "ping", max: 60, windowSeconds: 600 },
  // Stage 6 A4: every provider action together, per member; and one per target per minute (also absorbs double clicks).
  providerAction: { name: "provider-action", max: 10, windowSeconds: 600 },
  actionTarget: { name: "action-target", max: 1, windowSeconds: 60 },
  // Stage 7: "Back up now" (a whole backup, up to ~45 s) and the app page's GitHub refresh, per member.
  backupNow: { name: "backup-now", max: 3, windowSeconds: 600 },
  githubRefresh: { name: "github-refresh", max: 10, windowSeconds: 600 },
  // Stage 9 slice 5: the app page's dependency "Scan now" (a lockfile download and OSV queries, up to ~40 s), per member.
  depsScan: { name: "deps-scan", max: 5, windowSeconds: 600 },
  // Stage 9 slice 2: the SQL console's runs and the Firestore query builder's queries, per member.
  sqlRun: { name: "sql-run", max: 20, windowSeconds: 600 },
  firestoreQuery: { name: "firestore-query", max: 20, windowSeconds: 600 },
  // Stage 6 create requests (spec 2026-10-15 §5): 3 per member per (UTC) day across all providers.
  createRequest: { name: "create-request", max: 3, windowSeconds: 86_400 },
  // Self-host password sign-in, failed attempts only. The IP is known only behind a trusted proxy
  // (src/lib/local-auth/client-ip.ts). Per email alone the bar is higher, so a stranger can't easily lock an owner out.
  // A success gives back its email and email+IP hits; the shared per-IP count is only ever added to (on failures).
  passwordEmailIp: { name: "password-email-ip", max: 10, windowSeconds: 900 },
  passwordEmail: { name: "password-email", max: 50, windowSeconds: 900 },
  passwordIp: { name: "password-ip", max: 30, windowSeconds: 900 },
  // Not a refusal: failures across all emails past this only log a warning (once per window).
  passwordFailuresAll: { name: "password-failures-all", max: 300, windowSeconds: 900 },
  // Self-host password change: wrong current passwords per user (a stolen session can't brute-force the password).
  passwordChange: { name: "password-change", max: 5, windowSeconds: 900 },
} as const satisfies Record<string, Limit>;

export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function retryAfterSeconds(now: Date, windowSeconds: number): number {
  const end = windowStart(now, windowSeconds).getTime() + windowSeconds * 1000;
  return Math.ceil((end - now.getTime()) / 1000);
}

// Subjects are emails, IPs and member ids. Only a hash is stored.
export function subjectKey(limit: Limit, subject: string): string {
  const digest = createHash("sha256").update(subject.trim().toLowerCase()).digest("hex").slice(0, 32);
  return `${limit.name}:${digest}`;
}

export async function decide(limit: Limit, subject: string, deps: { hit: HitFn; now?: Date }): Promise<LimitDecision> {
  const now = deps.now ?? new Date();
  const count = await deps.hit(subjectKey(limit, subject), windowStart(now, limit.windowSeconds));
  return { allowed: count <= limit.max, retryAfter: retryAfterSeconds(now, limit.windowSeconds) };
}

// Read-only check for a count that was fetched without incrementing it.
export function peekDecision(limit: Limit, count: number, now: Date = new Date()): LimitDecision {
  return { allowed: count < limit.max, retryAfter: retryAfterSeconds(now, limit.windowSeconds) };
}

export function minutesText(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}
