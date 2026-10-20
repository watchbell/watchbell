import "server-only";
import type { ActionResult } from "@/lib/action";
import { accountPlans, slotsLeft } from "@/lib/data/keep-active-db";
import { type Actor, finish, type Finisher, loadTarget, targetQuota } from "@/lib/data/provider-action-db";
import { PAUSE_REQUESTED } from "@/lib/databases/keep-active";
import { supabaseState } from "@/lib/databases/supabase";
import { type ActionOutcome, scopeMessage, STALE } from "@/lib/provider-actions";
import type { Failure } from "@/lib/providers/http";
import { getProject, listProjects, pauseProject, restoreProject } from "@/lib/providers/supabase";

// Stage 6 Supabase Pause / Restore, the shared server half (Stage 9 moved it out of supabase/actions.ts so an approved
// office proposal runs the same guards: quota, the dialog's ref, the live status, the free slots, then the one write).
export const GONE = "This project isn't watched any more, or its credential can't be read.";
export const busy = (status: string) => `Supabase is busy with this project (${supabaseState(status).label.toLowerCase()}). Try again in a few minutes.`;

// The provider's failure as one sentence: a read-only token gets A6's sentence, never the body.
export const failed = (r: Failure, what: string, resourceId: string): ActionOutcome => ({
  done: false,
  failed: { ok: false, kind: r.kind, error: r.kind === "scope" ? scopeMessage("supabase", {}) : r.error, ...(r.status ? { status: r.status } : {}) },
  audit: { message: what, resourceId },
});

// No HTTP answer at all: the request may have reached Supabase.
export const mayHaveHappened = (r: Failure) => r.kind === "transient" && r.status === undefined;

export type Verb = "pause" | "restore";

// The caller has checked the role and the shapes (pauseAction / restoreAction), or the owner approved an office
// proposal (proposals-run.ts). `fin` audits: finish, or finish without a page refresh outside a server action.
export async function supabaseAct(verb: Verb, member: Actor, resourceId: string, expectedRef: string, fin: Finisher = finish): Promise<ActionResult> {
  const quota = await targetQuota(member.id, verb, resourceId);
  if (quota) return { ok: false, error: quota };
  const t = await loadTarget(resourceId, "supabase_project");
  if (!t) return { ok: false, error: GONE };
  if (t.resource.externalId !== expectedRef) return { ok: false, error: STALE };
  const ref = t.resource.externalId;
  const name = t.resource.name;
  const live = await getProject(t.token, ref);
  if (!live.ok) return fin({ done: false, message: live.kind === "scope" || live.kind === "auth" ? live.error : `Couldn't read this project's status at Supabase: ${live.error}` }, member, t.account.id);
  const status = live.data.status;

  let outcome: ActionOutcome;
  if (verb === "pause") {
    if (status === "INACTIVE" || status === "PAUSING" || status === "GOING_DOWN") return fin({ done: false, message: "Already paused." }, member, t.account.id);
    if (!status.startsWith("ACTIVE_")) return fin({ done: false, message: busy(status) }, member, t.account.id);
    const r = await pauseProject(t.token, ref);
    outcome = r.ok
      ? { done: true, message: `Pausing ${name}. It takes about 2 minutes.`, audit: { message: `${PAUSE_REQUESTED}${name}`, resourceId } }
      : mayHaveHappened(r)
        // M7: no answer (a timeout, or the connection dropped) means Supabase may still be pausing it. The audit keeps
        // "Pause requested" (kind err), so Auto-restore's "a member paused it" guard leaves the project paused.
        ? { done: false, failed: { ok: false, kind: "transient", error: `${r.error} The pause may still have happened; check the project in a few minutes before restoring it.` }, audit: { message: `${PAUSE_REQUESTED}${name}`, resourceId } }
        : failed(r, `Pause failed · ${name}`, resourceId);
  } else {
    if (status.startsWith("ACTIVE_") || status === "RESTORING" || status === "COMING_UP") return fin({ done: false, message: "Already active or restoring." }, member, t.account.id);
    if (status !== "INACTIVE") return fin({ done: false, message: busy(status) }, member, t.account.id);
    // A1: only with a free slot, counted over a fresh project list. An unknown plan counts as free; Supabase's own
    // refusal is then passed on.
    const list = await listProjects(t.token);
    if (!list.ok) return fin({ done: false, message: `Couldn't count this account's free slots just now: ${list.error}` }, member, t.account.id);
    const plans = await accountPlans(t.account.id);
    if (slotsLeft(list.data, plans, live.data.orgSlug) <= 0) {
      return fin({ done: false, message: "This account already uses both free slots. Pause one of its active projects first; Restore stays blocked until it shows Paused." }, member, t.account.id);
    }
    const r = await restoreProject(t.token, ref);
    outcome = r.ok
      ? { done: true, message: `Restoring ${name}. It takes about 2 minutes.`, audit: { message: `Restore requested · ${name}`, resourceId } }
      : failed(r, `Restore failed · ${name}`, resourceId);
  }
  return fin(outcome, member, t.account.id);
}

