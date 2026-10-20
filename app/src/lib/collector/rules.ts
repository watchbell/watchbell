import type { DeploymentState, VercelDeployment } from "@/lib/providers/vercel";
import type { State } from "@/lib/status";
import type { CheckResult } from "./http-check";

export const DOWN_AFTER = 3;
export const RECENT_MS = 10 * 60_000;

// `reason` (R2) names events whose message isn't a fixed string; recordEvents derives it for the fixed ones.
export type NewEvent = { resourceId: string | null; type: "deployment" | "monitor" | "system" | "database"; kind: State; message: string; detail: string | null; at: Date; reason?: string };

export function nextMonitorState(failStreak: number, r: CheckResult): { state: "ok" | "warn" | "err"; failStreak: number } {
  if (r.ok) return { state: "ok", failStreak: 0 };
  const streak = failStreak + 1;
  return { state: streak >= DOWN_AFTER ? "err" : "warn", failStreak: streak };
}

// Spec §9.4: down beats building beats degraded. From stage 3 a paused linked database also makes the app degraded (D7).
export function appState(input: { monitors: State[]; building: boolean; dbPaused?: boolean }): State {
  if (input.monitors.includes("err")) return "err";
  if (input.building) return "build";
  if (input.monitors.includes("warn") || input.dbPaused) return "warn";
  return input.monitors.length ? "ok" : "unknown";
}

// The check's own error first: a keyword or JSON miss comes back with status 200 and must not read as "HTTP 200".
const reason = (code: number | null, error: string | null) => error ?? (code ? `HTTP ${code}` : "No answer");

// A heartbeat (U3) passes its state text as `error` ("Down · no ping for 2 h") and its name as `path`: it isn't down
// "on 3 checks in a row", and it doesn't "answer", it pings.
// A first result (prev "unknown") is quiet, except a heartbeat going down from "waiting" or "resumed": that one opens
// an alert, so the timeline must show its cause too (5b final review M2).
export function monitorEvent(input: {
  resourceId: string; path: string; prev: State; next: State; code: number | null; error: string | null; at: Date; heartbeat?: boolean;
}): NewEvent | null {
  const { prev, next } = input;
  const hb = input.heartbeat === true;
  if (prev === next || (prev === "unknown" && !(hb && next === "err"))) return null;
  const base = { resourceId: input.resourceId, type: "monitor" as const, at: input.at };
  if (next === "err") return { ...base, kind: "err", message: "Monitor down", detail: hb ? reason(null, input.error) : `${reason(input.code, input.error)} on ${DOWN_AFTER} checks in a row` };
  if (next === "warn") return { ...base, kind: "warn", message: "Monitor degraded", detail: reason(input.code, input.error) };
  if (next === "ok") return { ...base, kind: "ok", message: "Monitor recovered", detail: hb ? `${input.path} pinged again` : `${input.path} answers again` };
  return null;
}

const where = (d: VercelDeployment) => `${d.branch ?? "unknown branch"} · ${d.sha ? d.sha.slice(0, 7) : "no commit"}`;

// History is not news: on the first sight of a deployment, only one that happened in the last 10 minutes produces an
// event. A build counts by when it was created; a finished one by when it finished (or was created, if it has no
// readyAt). This keeps the first collector run after Sync from flooding the timeline.
export function deploymentEvent(prev: DeploymentState | undefined, d: VercelDeployment, resourceId: string, at: Date): NewEvent | null {
  if (prev === d.state) return null;
  const base = { resourceId, type: "deployment" as const, at, detail: where(d) };
  const recent = (t: Date | null) => t !== null && at.getTime() - t.getTime() <= RECENT_MS;
  if (d.state === "building") {
    if (prev !== undefined || !recent(d.createdAt)) return null;
    return { ...base, kind: "build", message: "Deployment started" };
  }
  if (prev === undefined && !recent(d.readyAt ?? d.createdAt)) return null;
  if (d.state === "ready") return { ...base, kind: "ok", message: "Deployment ready" };
  if (d.state === "error") return { ...base, kind: "fail", message: "Deployment failed" };
  return { ...base, kind: "off", message: "Deployment canceled" };
}
