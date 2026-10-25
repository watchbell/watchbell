"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import {
  checkMonitorNow, createHeartbeat, createMonitor, deleteMonitor, type Done, recordTestPing, rotateToken, setAppMonitorsPaused, setMonitorPaused, updateHeartbeat, updateMonitor,
} from "@/lib/data/monitors-db";
import { moveMonitorToDomain } from "@/lib/data/monitor-move-db";
import { serverEnv } from "@/lib/env";
import { pingUrl } from "@/lib/heartbeat";
import { isUuid } from "@/lib/ids";
import { type HeartbeatForm, type MonitorForm, parseHeartbeatForm, parseMonitorForm } from "@/lib/monitors";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// R4/R5: monitor actions are real, change console rows only, and need an Owner or Operator.
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";
type Result = ActionResult<{ passed: boolean }>;
// U3: Add heartbeat and Show ping URL hand the new ping URL back once, for the dialog that shows it (null on Edit).
export type PingResult = ActionResult<{ pingUrl: string | null }>;

// Spec §12: a successful action leaves an "action" event with the acting user. A failed Check now is recorded as an
// error entry. The action already happened, so a failure to write the entry is logged and doesn't undo or hide it.
async function result(r: Done, member: GuardMember): Promise<Result> {
  if (!r.ok) return { ok: false, error: r.error };
  if (r.audit) {
    try {
      await recordAction({ kind: r.passed === false ? "err" : "ok", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
  }
  refresh();
  return { ok: true, message: r.message, data: { passed: r.passed ?? true } };
}

// The token never reaches the audit entry (Done.audit has none) or a log; it only goes into this one response.
async function pingResult(r: Done, member: GuardMember): Promise<PingResult> {
  const base = await result(r, member);
  if (!base.ok) return { ok: false, error: base.error };
  return { ok: true, message: base.message, data: { pingUrl: r.ok && r.token ? pingUrl(serverEnv().SITE_URL, r.token) : null } };
}

// Console-row writes: 60 per member per 10 minutes.
async function writeQuota(member: GuardMember): Promise<{ ok: false; error: string } | null> {
  const quota = await limit(LIMITS.monitorWrite, member.id);
  return quota.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
}

export async function addMonitor(appId: string, form: MonitorForm): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const p = parseMonitorForm(form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await result(await createMonitor(appId, p.value), member));
  }, deps, "local");
}

export async function editMonitor(id: string, form: MonitorForm): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    const p = parseMonitorForm(form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await result(await updateMonitor(id, p.value), member));
  }, deps, "local");
}

// Watchbell 1.2.1: Update monitor. The app moved to a new domain: the monitor checks the app's primary domain, same path.
export async function updateMonitorDomain(id: string): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await moveMonitorToDomain(id), member));
  }, deps, "local");
}

export async function pauseMonitor(id: string, paused: boolean): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id) || typeof paused !== "boolean") return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await setMonitorPaused(id, paused), member));
  }, deps, "local");
}

export async function pauseAppMonitors(appId: string, paused: boolean): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(appId) || typeof paused !== "boolean") return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await setAppMonitorsPaused(appId, paused), member));
  }, deps, "local");
}

export async function removeMonitor(id: string): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await deleteMonitor(id), member));
  }, deps, "local");
}

export async function checkNow(id: string): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.check, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many checks. Try again in ${minutesText(quota.retryAfter)}.` };
    return result(await checkMonitorNow(id), member);
  }, deps, "local");
}

// U3: Add monitor -> Heartbeat. Answers with the ping URL, shown once.
export async function addHeartbeat(appId: string, form: HeartbeatForm): Promise<PingResult> {
  return runGuarded("operator", async (member): Promise<PingResult> => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const p = parseHeartbeatForm(form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await pingResult(await createHeartbeat(appId, p.value), member));
  }, deps, "local");
}

export async function editHeartbeat(id: string, form: HeartbeatForm): Promise<PingResult> {
  return runGuarded("operator", async (member): Promise<PingResult> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    const p = parseHeartbeatForm(form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await pingResult(await updateHeartbeat(id, p.value), member));
  }, deps, "local");
}

// Show ping URL: a new token (the old URL stops working), behind the menu's confirm.
export async function newPingUrl(id: string): Promise<PingResult> {
  return runGuarded("operator", async (member): Promise<PingResult> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await pingResult(await rotateToken(id), member));
  }, deps, "local");
}

// Record a test ping (ok or fail) for a heartbeat, from its row menu. Operator or Owner only, with the same write quota
// as the other row actions; the ping is written by id, so no token is needed or exposed.
export async function recordTestPingAction(id: string, kind: "ok" | "fail"): Promise<Result> {
  return runGuarded("operator", async (member): Promise<Result> => {
    if (!isUuid(id) || (kind !== "ok" && kind !== "fail")) return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await recordTestPing(id, kind), member));
  }, deps, "local");
}
