import type { State } from "@/lib/status";
import { longDate } from "@/lib/view/format";

// Free-plan rules, checked 12 Oct 2026:
// - 2 free projects per user across the orgs they own or administer; paused ones don't count
//   (supabase.com/docs/guides/platform/billing-on-supabase).
// - Free projects pause after low activity over 7 days, and a paused project can be restored for up to 1 year
//   (supabase.com/docs/guides/platform/free-project-pausing; the 2024 changelog's 90 days is superseded).
export const FREE_SLOTS = 2;
export const RESTORE_WINDOW_DAYS = 365;
export const PAUSE_AFTER_DAYS = 7;
export const RISK_AFTER_DAYS = 4;
export const FREE_DB_BYTES = 500 * 1024 * 1024;
const DAY = 86_400_000;

const STATES: Record<string, [State, string]> = {
  ACTIVE_HEALTHY: ["ok", "Active healthy"], ACTIVE_UNHEALTHY: ["warn", "Active unhealthy"], INACTIVE: ["paused", "Paused"],
  RESTORING: ["build", "Restoring"], COMING_UP: ["build", "Starting"], PAUSING: ["build", "Pausing"], GOING_DOWN: ["build", "Pausing"],
  RESTARTING: ["build", "Restarting"], UPGRADING: ["build", "Upgrading"], RESIZING: ["build", "Resizing"],
  RESTORE_FAILED: ["err", "Restore failed"], PAUSE_FAILED: ["err", "Pause failed"], INIT_FAILED: ["err", "Setup failed"],
  REMOVED: ["off", "Removed"],
};

export function supabaseState(status: string): { state: State; label: string } {
  const [state, label] = STATES[status] ?? ["unknown", "Unknown"];
  return { state, label };
}

export const usesSlot = (status: string) => status !== "INACTIVE" && status !== "REMOVED";

// D3: projects in free orgs that use a slot, against 2. An org whose plan can't be read counts as free.
export function freeSlots(projects: { status: string; freeOrg: boolean | null }[]): { used: number; total: number; left: number; planUnknown: boolean } {
  const counted = projects.filter((p) => p.freeOrg !== false && usesSlot(p.status));
  return { used: counted.length, total: FREE_SLOTS, left: Math.max(0, FREE_SLOTS - counted.length), planUnknown: projects.some((p) => p.freeOrg === null) };
}

export function lastTraffic(buckets: { at: Date; total: number }[]): Date | null {
  return buckets.filter((b) => b.total > 0).reduce<Date | null>((m, b) => (!m || b.at > m ? b.at : m), null);
}

export const restoreDeadline = (pausedSince: Date) => new Date(pausedSince.getTime() + RESTORE_WINDOW_DAYS * DAY);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function autoPauseRisk(i: {
  status: string; lastTrafficAt: Date | null; trafficCheckedAt: Date | null; pausedSince: Date | null; pausedBeforeSeen: boolean; now: Date;
}): { state: State; text: string; note: string | null } {
  if (i.status === "INACTIVE") {
    if (i.pausedBeforeSeen || !i.pausedSince) return { state: "paused", text: "Restore within 1 year of pausing", note: "Paused before the console saw it" };
    return { state: "paused", text: `Restore by ${longDate(restoreDeadline(i.pausedSince))}`, note: "Paused free projects can be restored for 1 year" };
  }
  if (!i.status.startsWith("ACTIVE_") || !i.trafficCheckedAt) return { state: "unknown", text: "—", note: null };
  if (!i.lastTrafficAt) return { state: "err", text: "May pause any time", note: "No API traffic in the last 7 days" };
  const idle = (i.now.getTime() - i.lastTrafficAt.getTime()) / DAY;
  if (idle < RISK_AFTER_DAYS) return { state: "ok", text: "Low", note: null };
  if (idle >= PAUSE_AFTER_DAYS) return { state: "err", text: "May pause any time", note: "No API traffic for 7 days" };
  return { state: "warn", text: `Pauses in ~${plural(Math.max(1, Math.floor(PAUSE_AFTER_DAYS - idle)), "day")}`, note: "Supabase pauses free projects after 7 idle days" };
}

// D1: the size query is database activity, so it runs only where the project is in use anyway.
export function sizeDue(i: { status: string; lastTrafficAt: Date | null; sizeAt: Date | null; now: Date }): boolean {
  if (i.status !== "ACTIVE_HEALTHY" || !i.lastTrafficAt) return false;
  if (i.now.getTime() - i.lastTrafficAt.getTime() > DAY) return false;
  return !i.sizeAt || i.now.getTime() - i.sizeAt.getTime() >= DAY - 60 * 60_000;
}

// 1.2.1 (4c): Supabase → row menu → Check services. The Management API's /health answer as one sentence, the services
// that aren't healthy first. ok only when every service answered ACTIVE_HEALTHY.
const SERVICE_NAMES: Record<string, string> = { auth: "Auth", rest: "REST", realtime: "Realtime", storage: "Storage", db: "Database" };
export function servicesMessage(list: { name: string; status: string; error: string | null }[]): { ok: boolean; message: string } {
  if (!list.length) return { ok: false, message: "Supabase returned no service health for this project." };
  const name = (s: { name: string }) => SERVICE_NAMES[s.name] ?? s.name;
  const healthy = list.filter((s) => s.status === "ACTIVE_HEALTHY");
  const bad = list.filter((s) => s.status !== "ACTIVE_HEALTHY");
  if (!bad.length) return { ok: true, message: `All ${list.length} services are healthy: ${healthy.map(name).join(", ")}.` };
  const why = (s: { status: string; error: string | null }) => s.error || s.status.toLowerCase().replace(/_/g, " ");
  const parts = [`Not healthy: ${bad.map((s) => `${name(s)} (${why(s)})`).join(", ")}.`];
  if (healthy.length) parts.push(`Healthy: ${healthy.map(name).join(", ")}.`);
  return { ok: false, message: parts.join(" ") };
}
