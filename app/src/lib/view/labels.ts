import { DOWN_AFTER } from "@/lib/collector/rules";
import { collectorHealth } from "@/lib/collector/status";
import { bodyFailure, isChecked } from "@/lib/monitors";
import { hasRole, type Role } from "@/lib/roles";
import type { State } from "@/lib/status";
import { ago, clock } from "@/lib/time";
import { hideEmails } from "./display-name";
import { eventTime, forHowLong } from "./format";

export type Shown = { state: State; label: string };
// `kind` and `name` (U3): a heartbeat has no HTTP status to explain it, so the labels name the job instead.
// `maintUntil`: the end of the maintenance window the monitor is inside right now (U5), null or absent outside one.
export type MonitorBits = {
  state: State; lastStatus: number | null; lastError?: string | null; failStreak: number; paused: boolean; ownerPaused: boolean;
  kind?: "http" | "heartbeat"; name?: string | null; maintUntil?: Date | null;
};
const isHeartbeat = (m: { kind?: string } | null | undefined) => m?.kind === "heartbeat";

// R4/R5: owners and operators see action buttons; a viewer sees none (the server actions refuse viewers as well).
export const canAct = (role: Role): boolean => hasRole(role, "operator");

// Read out next to an icon that shows on its own (status icon + text, never colour alone).
export const STATE_WORD: Record<State, string> = {
  ok: "healthy", warn: "degraded", err: "down", idle: "idle", build: "building", paused: "paused", info: "info", fail: "failed", off: "off", unknown: "unknown", maint: "maintenance",
};

// The monitor that explains an app's state: a down one first, else a degraded one. Paused monitors don't count, and
// neither do monitors inside a maintenance window (U5): planned work doesn't explain a problem.
// A background job (heartbeat) never makes the app Down: the website may be fine. So the website's checks explain the
// state first, and a heartbeat only when nothing else does.
export function worstMonitor<T extends MonitorBits>(list: T[]): T | null {
  const live = list.filter((m) => isChecked(m) && !m.maintUntil);
  const site = live.filter((m) => !isHeartbeat(m));
  const jobs = live.filter(isHeartbeat);
  return site.find((m) => m.state === "err") ?? site.find((m) => m.state === "warn") ?? jobs.find((m) => m.state === "err") ?? jobs.find((m) => m.state === "warn") ?? null;
}

const reason = (m: { lastStatus: number | null; lastError?: string | null } | null) =>
  (m && bodyFailure(m)) ?? (m?.lastStatus ? `HTTP ${m.lastStatus}` : "no answer");

type AppBits = { state: State; gone: boolean; monitors: MonitorBits[]; dbPaused?: boolean; building?: boolean; lastDeploy?: { state: string } | null };

// U5 / review I1: the app's state as the pages show it. The stored state (the collector's appState) counts every
// monitor; a monitor inside a maintenance window is left out here, so an app whose only failing monitor is under
// planned work isn't red, and an app with every checked monitor in a window reads Maintenance. Otherwise the stored
// state stands. The order is appState's: down, then building, then degraded (a monitor or a paused database).
export function shownAppState(a: AppBits): { state: State; maintEnd: Date | null } {
  const live = a.monitors.filter(isChecked);
  const held = live.filter((m) => m.maintUntil);
  // A heartbeat in err or warn caps the app at Degraded: the stored state counts it as down, the pages don't.
  const jobDown = live.some((m) => isHeartbeat(m) && !m.maintUntil && (m.state === "err" || m.state === "warn"));
  const siteDown = live.some((m) => !isHeartbeat(m) && !m.maintUntil && m.state === "err");
  const capped: State = a.state === "err" && jobDown && !siteDown ? (a.building || a.lastDeploy?.state === "building" ? "build" : "warn") : a.state;
  if (a.gone || !held.length) return { state: capped, maintEnd: null };
  const maintEnd = held.reduce<Date>((e, m) => (m.maintUntil! > e ? m.maintUntil! : e), held[0].maintUntil!);
  const rest = live.filter((m) => !m.maintUntil);
  if (a.state === "err" || a.state === "warn") {
    if (rest.some((m) => !isHeartbeat(m) && m.state === "err")) return { state: "err", maintEnd };
    if (a.building || a.lastDeploy?.state === "building") return { state: "build", maintEnd };
    if (rest.some((m) => m.state === "warn" || (isHeartbeat(m) && m.state === "err")) || a.dbPaused) return { state: "warn", maintEnd };
    return { state: "maint", maintEnd };
  }
  if (!rest.length && (a.state === "ok" || a.state === "unknown")) return { state: "maint", maintEnd };
  return { state: capped, maintEnd };
}

// Applications → state filter (short names, as in the mockup).
export const APP_STATE_OPTIONS: [string, string][] = [["ok", "Running"], ["build", "Building"], ["warn", "Degraded"], ["err", "Down"]];

// Applications, app detail and Overview. The mockup's "Degraded · DB paused" / "Down · HTTP 502" are built from the
// real cause: a degraded app whose own monitors are all fine and whose linked database is paused says so (D7).
export function appStatus(a: AppBits): Shown {
  if (a.gone) return { state: "off", label: "Gone from Vercel" };
  const m = worstMonitor(a.monitors);
  // A heartbeat that explains the state is named: "Down · backup job", "Degraded · backup job late".
  const hb = isHeartbeat(m) ? (m?.name ?? "heartbeat") : null;
  const { state, maintEnd } = shownAppState(a);
  if (state === "maint" && maintEnd) return { state: "maint", label: `Maintenance · until ${clock(maintEnd)}` };
  if (state === "ok") return { state: "ok", label: "Running" };
  if (state === "build") return { state: "build", label: "Building" };
  if (state === "warn") {
    if (!m && a.dbPaused) return { state: "warn", label: "Degraded · DB paused" };
    if (hb) return { state: "warn", label: m?.state === "err" ? `Degraded · job ${hb} not pinging` : `Degraded · job ${hb} late` };
    return { state: "warn", label: `Degraded · ${reason(m)}` };
  }
  if (state === "err") return { state: "err", label: hb ? `Down · ${hb}` : `Down · ${reason(m)}` };
  return a.monitors.some(isChecked) ? { state: "unknown", label: "Not checked yet" } : { state: "unknown", label: "No active monitors" };
}

// The accessible name of a row's kebab: "Actions for shortly", "Actions for shortly abc1234", "Actions for shortly /health".
export const actionsLabel = (...parts: (string | null | undefined)[]): string => `Actions for ${parts.filter(Boolean).join(" ")}`;

export const DEP_STATE_OPTIONS: [string, string][] = [["ok", "Ready"], ["build", "Building"], ["fail", "Error"]];

export function deploymentStatus(state: string): Shown {
  if (state === "ready") return { state: "ok", label: "Ready" };
  if (state === "building") return { state: "build", label: "Building" };
  if (state === "error") return { state: "fail", label: "Error" };
  return { state: "off", label: "Canceled" };
}

export const MONITOR_STATE_OPTIONS: [string, string][] = [["ok", "Up"], ["warn", "Degraded"], ["err", "Down"], ["maint", "Maintenance"]];

// `appGone`: the app's project no longer exists at Vercel, which is a different thing from an app that isn't ticked in Sync.
// `active`: the maintenance window the monitor is inside now (U5, lib/maintenance activeFor), else the monitor's own
// `maintUntil` (listApps sets it). The pause flags still win; a window wins over the heartbeat and HTTP states (B3).
// A heartbeat (U3) reads from its last ping and the reason the collector stored: "Up · pinged 12 min ago", "Late",
// "Down · no ping for 2 h", "Waiting for the first ping". `now` dates the "pinged … ago".
export function monitorStatus(
  m: {
    state: State; lastStatus: number | null; lastError?: string | null; paused: boolean; ownerPaused: boolean; appGone?: boolean;
    maintUntil?: Date | null; kind?: string; lastPingAt?: Date | null;
    // Watchbell 1.2.1: the host is no longer a domain of the app (lib/domain-move.ts).
    move?: { from: string; to: string } | null;
  },
  active?: { end: Date } | null,
  now: Date = new Date(),
): Shown {
  if (m.appGone) return { state: "off", label: "App removed from Vercel" };
  if (m.ownerPaused) return { state: "paused", label: "Paused" };
  if (m.paused) return { state: "off", label: "App not watched" };
  const end = active?.end ?? m.maintUntil;
  if (end) return { state: "maint", label: `Maintenance · until ${clock(end)}` };
  if (isHeartbeat(m)) {
    if (m.state === "ok") return { state: "ok", label: m.lastPingAt ? `Up · pinged ${ago(m.lastPingAt, now)}` : "Up" };
    if (m.state === "warn") return { state: "warn", label: "Late" };
    if (m.state === "err") return { state: "err", label: m.lastError?.startsWith("Down · ") ? m.lastError : "Down · no ping" };
    return { state: "unknown", label: "Waiting for the first ping" };
  }
  // A moved domain isn't the app being down: a warning that names the new domain (Update monitor fixes it).
  if (m.move) return { state: "warn", label: `Domain changed: ${m.move.from} → ${m.move.to}` };
  const code = bodyFailure(m) ?? (m.lastStatus === null ? "no answer" : String(m.lastStatus));
  if (m.state === "ok") return { state: "ok", label: "Up" };
  if (m.state === "warn") return { state: "warn", label: `Degraded · ${code}` };
  if (m.state === "err") return { state: "err", label: `Down · ${code}` };
  return { state: "unknown", label: "Waiting for first check" };
}

// Events → type filter, in the mockup's order. "action" rows (stage 6) still get a label.
export const EVENT_TYPES = [["deployment", "Deployment"], ["monitor", "Monitor"], ["database", "Database"], ["system", "System"], ["action", "Action"]] as const;
export const EVENT_TYPE_LABEL: Record<string, string> = { deployment: "Deployment", monitor: "Monitor", database: "Database", system: "System", action: "Action" };

const RANK: Record<State, number> = { err: 6, fail: 6, warn: 5, paused: 5, build: 4, unknown: 3, idle: 2, off: 1, info: 1, maint: 1, ok: 0 };

export function worst(states: State[]): State {
  return states.reduce<State>((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Overview → status strip, Vercel cell: "6 apps · 1 down, 1 building".
export function vercelCell(apps: State[]): { state: State; sub: string; empty?: boolean } {
  if (!apps.length) return { state: "unknown", sub: "No apps watched yet", empty: true };
  const n = (s: State) => apps.filter((x) => x === s).length;
  const parts = ([["err", "down"], ["warn", "degraded"], ["build", "building"]] as const)
    .filter(([s]) => n(s) > 0).map(([s, w]) => `${n(s)} ${w}`);
  return { state: worst(apps), sub: `${plural(apps.length, "app")}${parts.length ? ` · ${parts.join(", ")}` : ""}` };
}

// Overview → status strip, Collector cell: "12s ago · 1.9 s · 18 checks". The icon follows the sidebar's rule.
export function collectorCell(run: { finishedAt: Date; durationMs: number | null; checks: number } | null, now: Date): { state: State; sub: string } {
  if (!run) return { state: "unknown", sub: "Hasn't run yet" };
  const took = run.durationMs === null ? "—" : `${(run.durationMs / 1000).toFixed(1)} s`;
  return { state: collectorHealth(run.finishedAt, now).state, sub: `${ago(run.finishedAt, now)} · ${took} · ${plural(run.checks, "check")}` };
}

const ORDER: State[] = ["ok", "build", "idle", "paused", "maint", "warn", "err", "fail", "unknown", "off", "info"];

// Overview → Inventory counts. Zero counts are left out.
export function stateCounts(states: State[]): { state: State; n: number }[] {
  return ORDER.map((state) => ({ state, n: states.filter((s) => s === state).length })).filter((c) => c.n > 0);
}

export type BannerApp = {
  id: string; name: string; state: State; gone: boolean; since: Date | null; monitors: MonitorBits[];
  lastDeploy: { state: string; createdAt: Date; readyAt: Date | null } | null; dbPaused?: boolean;
};
export type ProblemBanner = { key: string; tone: "danger" | "warning"; title: string; body: string; action: { label: string; href: string } };

// Overview: one banner per active problem, danger for down apps, warning for degraded ones (mockup rule).
export function problemBanners(apps: BannerApp[], now: Date): ProblemBanner[] {
  const out: ProblemBanner[] = [];
  for (const a of apps) {
    // U5: the state the pages show, so planned work inside a maintenance window raises no banner.
    const state = shownAppState(a).state;
    if (a.gone || (state !== "err" && state !== "warn")) continue;
    const m = worstMonitor(a.monitors);
    // A paused linked database is explained by its own banner ("Supabase project … is paused"), not twice.
    if (state === "warn" && !m && a.dbPaused) continue;
    const why = m && bodyFailure(m) ? bodyFailure(m)! : m?.lastStatus ? `HTTP ${m.lastStatus}` : "No answer";
    const open = { label: "Open app", href: `/apps/${a.id}` };
    const hb = isHeartbeat(m) ? (m?.name ?? "heartbeat") : null;
    if (hb && m?.state === "err") {
      out.push({ key: a.id, tone: "warning", title: `${a.name}: background job ${hb} is down`, body: `The website is up; the job hasn't pinged${a.since ? ` for ${forHowLong(a.since, now)}` : ""}.`, action: { label: "Open Uptime", href: "/uptime" } });
      continue;
    }
    if (hb) {
      out.push({ key: a.id, tone: "warning", title: `${a.name} is degraded`, body: `The job ${hb} is late. It's marked down once its grace time passes too.`, action: { label: "Open Uptime", href: "/uptime" } });
      continue;
    }
    if (state === "err") {
      const failed = a.lastDeploy?.state === "error" ? a.lastDeploy : null;
      out.push({
        key: a.id, tone: "danger", title: `${a.name} is down`,
        body: `${why}${a.since ? ` for ${forHowLong(a.since, now)}` : ""}.${failed ? ` The last production deploy failed at ${eventTime(failed.readyAt ?? failed.createdAt, now)}.` : ""}`,
        action: failed ? { label: "View deployment", href: "/deployments" } : open,
      });
    } else {
      const n = Math.max(1, m?.failStreak ?? 1);
      out.push({ key: a.id, tone: "warning", title: `${a.name} is degraded`, body: `${why} on ${plural(n, "check")} in a row. It's marked down after ${DOWN_AFTER}.`, action: open });
    }
  }
  return [...out.filter((b) => b.tone === "danger"), ...out.filter((b) => b.tone === "warning")];
}

// Overview → credential banner. A viewer sees provider names only (spec §13: no credential metadata).
export function credentialBanner(broken: { provider: string; label: string }[], role: Role): { title: string; body: string } | null {
  if (!broken.length) return null;
  const n = broken.length;
  const names = role === "viewer" ? [...new Set(broken.map((b) => b.provider))] : broken.map((b) => `${b.provider} · ${hideEmails(b.label)}`);
  return {
    title: `${n} connection${n > 1 ? "s need" : " needs"} attention`,
    body: `${names.join(", ")}. Data from ${n > 1 ? "these accounts is" : "this account is"} not being updated.`,
  };
}
