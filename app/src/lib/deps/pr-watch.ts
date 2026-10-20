// Automatic security fixes: the watcher of Watchbell's own update PRs (owner 16 Oct). Pure. Every 2 minutes, for each
// open Watchbell PR: GitHub's checks → Vercel's preview of the PR's head commit → a smoke test of that preview →
// auto-rollback must be on → squash-merge (with the head SHA the checks were read at). Anything failing stops the PR
// with a reason (it stays open for the owner); nothing finishing within 45 minutes stops it as "butuh dicek".

export const WATCH_EVERY_MS = 2 * 60_000;
export const WATCH_TIMEOUT_MS = 45 * 60_000;
export const SMOKE_TIMEOUT_MS = 15_000;
export const QUIET_MS = 3 * 60_000;
export const SMOKE_PATHS_MAX = 3;

export type PrStage = "checks" | "preview" | "smoke" | "merging" | "merged" | "ready-manual" | "failed" | "timeout" | "closed";
export const OPEN_STAGES: readonly PrStage[] = ["checks", "preview", "smoke", "merging"];

// How the app page and the office say it (≤ 200 with the reason).
export const STAGE_TEXT: Record<PrStage, string> = {
  checks: "waiting for CI", preview: "waiting for preview", smoke: "smoke test", merging: "merging…", merged: "merged ✅",
  "ready-manual": "ready to merge (manual)", failed: "needs a look ⚠️", timeout: "needs a look ⚠️", closed: "closed",
};
export const stageLine = (n: number, stage: PrStage, reason?: string | null): string => {
  const t = `PR #${n}: ${STAGE_TEXT[stage]}${reason ? ` — ${reason}` : ""}`;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

// ---- GitHub checks ----
export type CheckRun = { status: string; conclusion: string | null };
export type ChecksInput = { checkRuns: CheckRun[] | null; combined: { state: string; total: number } | null; actionRuns: CheckRun[] | null };
export type ChecksVerdict = "success" | "pending" | "failure";

const OK = new Set(["success", "neutral", "skipped"]);
const runVerdict = (r: CheckRun): ChecksVerdict =>
  r.status !== "completed" ? "pending" : OK.has(r.conclusion ?? "") ? "success" : "failure";

// All check runs and commit statuses green (neutral / skipped count as ok). When the token can read neither checks nor
// statuses, the repository's Actions runs for the commit stand in (also when only the check runs are unreadable: a
// fine-grained token can't read them). Nothing to wait for at all → success.
export function checksVerdict(c: ChecksInput): ChecksVerdict {
  const runs = c.checkRuns ?? c.actionRuns ?? [];
  const verdicts = runs.map(runVerdict);
  if (c.combined && c.combined.total > 0) verdicts.push(c.combined.state === "success" ? "success" : c.combined.state === "pending" ? "pending" : "failure");
  if (verdicts.includes("failure")) return "failure";
  return verdicts.includes("pending") ? "pending" : "success";
}

// ---- the smoke test ----
export type HttpProbe = { path: string; status: number | null; ms: number; authWall: boolean };
export type SmokeVerdict = { mode: "http" | "logs"; result: "pass" | "fail" | "wait"; reason: string | null };

// A Vercel Authentication wall: 401 / 403 with Vercel's sign-in page or SSO cookie.
export function isAuthWall(status: number, body: string, headers: { get(name: string): string | null }): boolean {
  if (status !== 401 && status !== 403) return false;
  return /vercel\.com\/(sso|login)|Authentication Required|_vercel_sso|vercel-authentication/i.test(body)
    || /_vercel_sso/i.test(headers.get("set-cookie") ?? "") || (headers.get("server") ?? "").toLowerCase() === "vercel";
}

// HTTP mode: every probe 200–399 within the timeout. A wall on any probe → the logs mode decides instead.
export function httpVerdict(probes: HttpProbe[]): SmokeVerdict | null {
  if (!probes.length || probes.some((p) => p.authWall)) return null;
  const bad = probes.find((p) => p.status === null || p.status < 200 || p.status > 399);
  if (!bad) return { mode: "http", result: "pass", reason: null };
  return { mode: "http", result: "fail", reason: bad.status === null ? `${bad.path} didn't answer within 15 seconds` : `${bad.path} answered ${bad.status}` };
}

// Logs mode (preview behind Vercel Authentication): no error-level lines for 3 minutes after READY.
export function logsVerdict(readyAt: Date, now: Date, errors: number | null): SmokeVerdict {
  if (errors !== null && errors > 0) return { mode: "logs", result: "fail", reason: `${errors} errors in the preview logs` };
  if (now.getTime() - readyAt.getTime() < QUIET_MS || errors === null) return { mode: "logs", result: "wait", reason: null };
  return { mode: "logs", result: "pass", reason: null };
}

// ---- one watch step ----
export type WatchInput = {
  now: Date; openedAt: Date;
  pr: { state: "open" | "closed"; merged: boolean; mergeable: boolean | null; headSha: string };
  recordedSha: string;
  checks: ChecksVerdict;
  preview: { state: "ready" | "building" | "error" | "canceled" | null; readyAt: Date | null };
  smoke: SmokeVerdict | null; // null until the preview is ready
  autoRollbackOn: boolean;
};

export type WatchStep =
  | { kind: "wait"; stage: PrStage; reason: string | null; resetSha?: string }
  | { kind: "merge" }
  | { kind: "stop"; stage: "failed" | "timeout" | "ready-manual"; reason: string }
  | { kind: "done"; stage: "merged" | "closed" };

export function watchStep(w: WatchInput): WatchStep {
  if (w.pr.merged) return { kind: "done", stage: "merged" };
  if (w.pr.state === "closed") return { kind: "done", stage: "closed" };
  // Someone pushed to the branch (often the lockfile the PR body asks for): the checks start again on the new commit.
  if (w.pr.headSha !== w.recordedSha) return { kind: "wait", stage: "checks", reason: "new commit on the PR branch, checking again", resetSha: w.pr.headSha };
  const late = w.now.getTime() - w.openedAt.getTime() > WATCH_TIMEOUT_MS;
  if (w.checks === "failure") return { kind: "stop", stage: "failed", reason: "CI failed" };
  if (w.pr.mergeable === false) return { kind: "stop", stage: "failed", reason: "conflicts with the main branch" };
  if (w.preview.state === "error" || w.preview.state === "canceled") return { kind: "stop", stage: "failed", reason: "Vercel preview failed" };
  if (w.checks === "pending" || w.pr.mergeable === null) {
    return late ? { kind: "stop", stage: "timeout", reason: "CI not finished within 45 minutes" } : { kind: "wait", stage: "checks", reason: null };
  }
  if (w.preview.state !== "ready") {
    return late ? { kind: "stop", stage: "timeout", reason: "preview not ready within 45 minutes" } : { kind: "wait", stage: "preview", reason: null };
  }
  if (!w.smoke || w.smoke.result === "wait") {
    return late ? { kind: "stop", stage: "timeout", reason: "preview smoke test not finished within 45 minutes" } : { kind: "wait", stage: "smoke", reason: null };
  }
  if (w.smoke.result === "fail") return { kind: "stop", stage: "failed", reason: `preview smoke test failed: ${w.smoke.reason ?? "?"}` };
  if (!w.autoRollbackOn) return { kind: "stop", stage: "ready-manual", reason: "PR is ready to merge, but auto-rollback is off; merge it manually" };
  return { kind: "merge" };
}

// Every 2 minutes per server instance (a module memo), and on a cold instance only on even minutes.
export function watchDue(now: Date, last: number | null): boolean {
  const t = now.getTime();
  if (last !== null && t - last < WATCH_EVERY_MS - 20_000) return false;
  return Math.floor(t / 60_000) % 2 === 0 || (last !== null && t - last >= WATCH_EVERY_MS * 2);
}

// The app's paths to probe on the preview: "/" and up to 3 HTTP monitor paths (no query strings, no duplicates).
export function smokePaths(monitorUrls: string[]): string[] {
  const out = ["/"];
  for (const u of monitorUrls) {
    let p: string;
    try {
      p = new URL(u).pathname || "/";
    } catch {
      continue;
    }
    if (!out.includes(p) && out.length < SMOKE_PATHS_MAX + 1) out.push(p);
  }
  return out;
}
