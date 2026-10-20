import "server-only";
import type { ActionResult } from "@/lib/action";
import { readAliasBook } from "@/lib/data/aliases-db";
import { wakeScope, type WakeScope } from "@/lib/data/neon-action-db";
import { type Actor, finish, type Finisher, loadTarget, type Target, targetQuota } from "@/lib/data/provider-action-db";
import { NEON_FREE } from "@/lib/databases/neon";
import { type ActionOutcome, scopeMessage, STALE, type WriteFailure } from "@/lib/provider-actions";
import { getEndpoint, startEndpoint } from "@/lib/providers/neon";
import { hideNames } from "@/lib/view/display-name";

// Stage 6 Neon Wake, the shared server half (Stage 9 moved it out of neon/actions.ts so an approved office proposal
// runs the same guards: the per-compute cooldown, the CU-hours, the live endpoint, then the one write, audited).
export const ENDPOINT_ID = /^ep-[a-z0-9-]{3,60}$/;
const CU_OUT = `This project used its ${NEON_FREE.cuHours} CU-hours; the compute won't start until the quota resets.`;

// The CU-hours come from the last snapshot (no call). A snapshot from a period that has already ended doesn't count.
function cuUsedUp(s: WakeScope, now: Date): boolean {
  if ((s.computeSeconds ?? 0) < NEON_FREE.cuHours * 3600) return false;
  return !s.periodEnd || new Date(s.periodEnd).getTime() > now.getTime();
}

async function wake(t: Target, s: WakeScope, endpointId: string): Promise<ActionOutcome> {
  if (cuUsedUp(s, new Date())) return { done: false, message: CU_OUT };
  const projectId = t.resource.externalId;
  // The dialog's endpoint must still belong to this project (and branch) right now: the stale-dialog guard (A3).
  const ep = await getEndpoint(t.token, projectId, endpointId);
  if (!ep.ok) return { done: false, message: ep.kind === "missing" ? STALE : ep.error };
  if (ep.data.id !== endpointId || (s.branchExternalId && ep.data.branchId !== s.branchExternalId)) return { done: false, message: STALE };
  if (ep.data.disabled) return { done: false, message: "Neon has disabled this compute, so it can't be started from here." };
  if (ep.data.state === "active") return { done: false, message: "Already running." };
  if (ep.data.state === "init" || ep.data.pendingState === "active") return { done: false, message: "Already starting." };

  const r = await startEndpoint(t.token, projectId, endpointId);
  if (r.ok) {
    return { done: true, message: `Waking ${endpointId}. Ready in a few seconds.`, audit: { message: `Wake requested · ${endpointId}`, resourceId: t.resource.id } };
  }
  // Only the kind, status and a sentence of ours go on: never the provider's body (A6).
  const error = r.kind === "scope" ? scopeMessage("neon", { project: t.resource.name }) : r.kind === "missing" ? STALE : r.error;
  const failed: WriteFailure = { ok: false, kind: r.kind, error, ...(r.status ? { status: r.status } : {}) };
  return { done: false, failed, audit: { message: `Wake failed · ${endpointId}`, resourceId: t.resource.id } };
}

// Privacy (lib/view/display-name.ts): a toast never shows a database's real name (the A6 sentence names the project).
// The audit keeps it; events are masked on display. If the letters can't be read, the name still goes.
async function hideName(r: ActionResult, t: Target): Promise<ActionResult> {
  const name = t.resource.name;
  if (r.ok || name.trim().length < 2 || !r.error.includes(name)) return r;
  const book = await readAliasBook().catch(() => null);
  return { ...r, error: book ? hideNames(r.error, book, t.resource.id) : r.error.split(name).join("db-?") };
}

// The caller has checked the role and the shapes (wakeAction), or the owner approved an office proposal.
export async function wakeAs(member: Actor, resourceId: string, endpointId: string, fin: Finisher = finish): Promise<ActionResult> {
  // The cooldown target is the compute (A4 key `wake:{endpoint}`): Neon endpoint ids are unique, and two computes
  // of one project can each be woken once a minute.
  const quota = await targetQuota(member.id, "wake", endpointId);
  if (quota) return { ok: false, error: quota };
  const s = await wakeScope(resourceId);
  const t = s ? await loadTarget(s.projectResourceId, "neon_project") : null;
  if (!s || !t) return { ok: false, error: STALE };
  return hideName(await fin(await wake(t, s, endpointId), member, t.account.id), t);
}
