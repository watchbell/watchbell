import { bodyFailure, isChecked } from "@/lib/monitors";
import { type DbKind, dbHref } from "@/lib/links";
import type { State } from "@/lib/status";
import { STATE_WORD } from "./labels";
import { shortSha } from "./format";

// "Why is this app Degraded / Down?": where the problem is, what it says, since when, and what to do about it. Built from
// what the app page already has, so it reads nothing more. Pure.

export type WhyMonitor = {
  id: string; path: string; name?: string | null; kind?: "http" | "heartbeat"; state: State;
  lastStatus: number | null; lastError?: string | null; paused: boolean; ownerPaused: boolean;
  maintUntil?: Date | null; stateSince?: Date | null; lastPingAt?: Date | null;
};
export type WhyApp = {
  gone: boolean; stateSince?: Date | null; dbPaused?: boolean;
  monitors: WhyMonitor[];
  // The linked database; `name` is what the page shows for it (its alias, db-a), never the real name.
  database?: { id: string; kind: DbKind; name: string } | null;
  // The latest production deployment.
  lastDeploy?: { state: string; commitSha: string | null; createdAt: Date; readyAt?: Date | null } | null;
};
export type Problem = {
  kind: "monitor" | "database" | "deployment";
  where: string; subject: string; state: State; reason: string; since: Date | null; href: string; remedies: string[];
};

const dropDown = (t: string) => t.replace(/^(Down|Late) · /, "");

// The database and deployment remedies, also read by the Kantor Virtual room alarms (src/private/office/alarms.ts).
export const DB_PAUSED_REMEDY = "Restore the database from its provider (Supabase restore)";
export const DEPLOY_FAILED_REMEDY = "Open the deployment's build logs; redeploy after fixing";

export function heartbeatRemedies(m: WhyMonitor): string[] {
  const e = (m.lastError ?? "").toLowerCase();
  if (e.includes("failure")) return ["The job reported a failure: open its logs", "Fix and re-run the job; the next OK ping clears it"];
  if (e.includes("didn't finish") || e.includes("started")) {
    return ["The job started but never finished: it may have hung or hit its timeout", "Check the job's own logs for where it stopped", "Raise the job's timeout, or fix what it waits on; the next OK ping clears it"];
  }
  return [
    "Check that the job's scheduler ran (cron, Vercel Cron, GitHub Actions)",
    "Check the job's own logs for errors before the ping line",
    "Make sure the job calls the ping URL at the end (curl -fsS -m 10 <url>)",
    "If the job is retired, pause or delete the heartbeat",
  ];
}

export function httpRemedies(m: WhyMonitor): string[] {
  const err = m.lastError ?? "";
  if (/blocked address/i.test(err)) return ["The monitor's URL resolves to a private address; fix the URL in Edit monitor"];
  const body = bodyFailure(m);
  if (body && /keyword|json|body|content/i.test(body)) return ["The page answered but its content changed: check the keyword or JSON path in Edit monitor, or the page itself"];
  const code = m.lastStatus;
  if (code !== null && code >= 500) return ["Open Logs (last hour) for errors", "Check the latest deployment; roll back if it started after the deploy"];
  if (code !== null && code >= 300) return ["Check the expected status and path in Edit monitor", "The route may need sign-in or moved"];
  if (code === null || body) return ["Check the domain, DNS and the provider status page", "Cold start or overload: retry with Check now"];
  return ["Open Logs (last hour) for errors", "Check the latest deployment; roll back if it started after the deploy"];
}

const reasonOf = (m: WhyMonitor): string => {
  if (m.kind === "heartbeat") return m.lastError ? dropDown(m.lastError) : m.state === "warn" ? "Late" : "No ping";
  return bodyFailure(m) ?? (m.lastStatus ? `HTTP ${m.lastStatus}` : m.lastError || "No answer");
};

// Problems of an app, worst first: the website's monitors, then jobs, then the database, then a failed deployment.
// Paused monitors and monitors inside a maintenance window aren't problems.
export function problemsOf(app: WhyApp, _now: Date): Problem[] {
  if (app.gone) return [];
  void _now;
  const out: Problem[] = [];
  const live = app.monitors.filter((m) => isChecked(m) && !m.maintUntil && (m.state === "err" || m.state === "warn"));
  const rank = (m: WhyMonitor) => (m.kind === "heartbeat" ? 2 : 0) + (m.state === "err" ? 0 : 1);
  for (const m of [...live].sort((a, b) => rank(a) - rank(b))) {
    const hb = m.kind === "heartbeat";
    const name = hb ? (m.name ?? m.path) : m.path;
    out.push({
      kind: "monitor", where: hb ? `Monitor ${name} (heartbeat)` : `Monitor ${name}`, subject: name, state: m.state, reason: reasonOf(m),
      since: m.stateSince ?? (hb ? m.lastPingAt ?? null : null), href: "/uptime", remedies: hb ? heartbeatRemedies(m) : httpRemedies(m),
    });
  }
  if (app.dbPaused && app.database) {
    out.push({
      kind: "database", where: `Database ${app.database.name}`, subject: app.database.name, state: "warn", reason: "Paused",
      since: app.stateSince ?? null, href: dbHref(app.database.kind), remedies: [DB_PAUSED_REMEDY],
    });
  }
  const d = app.lastDeploy;
  if (d && d.state === "error") {
    const sha = shortSha(d.commitSha);
    out.push({
      kind: "deployment", where: `Production deployment ${sha}`, subject: sha, state: "fail", reason: "Build failed", since: d.readyAt ?? d.createdAt, href: "/deployments",
      remedies: [DEPLOY_FAILED_REMEDY],
    });
  }
  return out;
}

// The popover's title word: "Why degraded", "Why down".
export const whyTitle = (state: State): string => `Why ${STATE_WORD[state]}`;

// True when every problem is a background job: the website itself answers.
export const onlyJobs = (ps: Problem[]): boolean => ps.length > 0 && ps.every((p) => p.kind === "monitor" && p.where.endsWith("(heartbeat)"));
