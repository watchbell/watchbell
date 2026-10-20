// R2 (feature ideas): every event carries a reason code. The same reason on the same resource within an hour is one
// row with a repeat count, so a flapping site reads "Monitor degraded ×12, last 2 min ago" instead of 12 rows.
import { ago } from "@/lib/time";

export type Reason =
  | "MonitorDown" | "MonitorDegraded" | "MonitorRecovered" | "DeployStarted" | "DeployReady" | "DeployFailed" | "DeployCanceled"
  | "CollectorStopped" | "DailyFinished" | "DailyProblems" | "NextVulnerable" | "NextClean" | "ProviderIncident" | "ProviderRecovered"
  | "LogCapReached" | "Action"
  // Stage 3 databases (lib/databases/events.ts) and stage 4 zones and domains (lib/network/rules.ts networkEvent).
  | "DatabasePaused" | "DatabaseRestored" | "DatabaseUnhealthy" | "DatabaseFailed" | "NeonSuspended" | "NeonAvailable"
  | "FirestoreQuotaUsedUp" | "FirestoreUnreachable" | "FirestoreMissing" | "FirestoreReachable" | "NetworkAttention" | "NetworkRecovered"
  | "DatabaseMissing" // stage 8: a Turso, Upstash or D1 database the provider no longer lists
  | (string & {});

export const REPEAT_WINDOW_MS = 3_600_000;

const FIXED: Record<string, Record<string, Reason>> = {
  monitor: { "Monitor down": "MonitorDown", "Monitor degraded": "MonitorDegraded", "Monitor recovered": "MonitorRecovered" },
  deployment: { "Deployment started": "DeployStarted", "Deployment ready": "DeployReady", "Deployment failed": "DeployFailed", "Deployment canceled": "DeployCanceled" },
  system: { "Collector stopped": "CollectorStopped", "Daily jobs finished": "DailyFinished", "Daily jobs finished with problems": "DailyProblems" },
};

export function reasonFor(e: { type: string; message: string; reason?: string | null }): Reason | null {
  if (e.reason) return e.reason;
  if (e.type === "action") return "Action";
  return FIXED[e.type]?.[e.message] ?? null;
}

// Every action is its own audit entry (who did what, when), so actions are never folded together.
export function repeatable(reason: string | null): boolean {
  return reason !== null && reason !== "Action";
}

export function repeatText(count: number, lastAt: Date | null, now: Date): string | null {
  if (count <= 1 || !lastAt) return null;
  return `×${count} · last ${ago(lastAt, now)}`;
}

// What an event row names as its resource. A provider-status event has none (the provider isn't a resource row), so the
// provider's name comes out of the message ("Cloudflare reports an incident", "Cloudflare incident resolved"); the rest
// of the resource-less events are the collector's own (system) or the console's.
const PROVIDER_MESSAGE = /^(.+?) (?:reports an incident|incident resolved)$/;
export function eventSource(e: { type: string; reason: string | null; message: string; resource: string | null }): string {
  if (e.resource) return e.resource;
  if (e.reason === "ProviderIncident" || e.reason === "ProviderRecovered") {
    const m = PROVIDER_MESSAGE.exec(e.message);
    if (m) return m[1];
  }
  return e.type === "system" ? "collector" : "console";
}
