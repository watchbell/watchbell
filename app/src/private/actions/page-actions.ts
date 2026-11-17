"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { telegramTarget } from "@/lib/data/notify-db";
import { isProposalId, toProposal } from "./proposals";
import { askAgain } from "./proposals-db";
import { decideAndRun } from "./proposals-decide";
import { notifyNewProposals } from "./proposals-notify";
import { PROPOSAL_TTL_MS } from "./proposals-types";

// The Auto-actions page's Approve / Reject (owner only, checked again here whatever the page showed). The same decide
// path as the office route and the Telegram buttons (proposals-decide.ts), with the office route's messages: an approval
// runs the action at once with this owner as the actor, so the answer carries its result.
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";

export async function decideProposalAction(id: string, decision: "approve" | "reject"): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isProposalId(id) || (decision !== "approve" && decision !== "reject")) return { ok: false, error: INVALID };
    let d: Awaited<ReturnType<typeof decideAndRun>>;
    try {
      d = await decideAndRun(id, decision, { id: member.id, userId: member.userId }, new Date());
    } catch (e) {
      console.warn("auto-actions decide failed:", e instanceof Error ? e.name : "error");
      // The approval may already be recorded when the run itself throws, so no retry is implied: show the row as it is now.
      refresh();
      return { ok: false, error: "The console couldn't confirm what happened. The proposal may already be approved or running, so check History before doing anything else." };
    }
    if (d.status === "missing") return { ok: false, error: "Unknown proposal." };
    refresh(); // the row moves to History (or shows who got there first)
    if (d.status === "ok" && d.flushHistory) after(d.flushHistory); // Discord history, after the answer
    const p = d.proposal;
    if (d.status === "conflict") return { ok: false, error: p.status === "pending" ? "This proposal has expired." : `This proposal is already ${p.status}.` };
    if (p.status === "rejected") return { ok: true, message: "Rejected." };
    if (p.status === "failed") return { ok: false, error: p.result ?? "It didn't run." };
    return { ok: true, message: p.result ?? "Approved. It's running." };
  }, deps, "local");
}

// For the page's <form>: the pressed button carries the decision, a hidden field the id (both checked above, after the
// owner check).
export async function decideProposalForm(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const text = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };
  return decideProposalAction(text("id"), text("decision") as "approve" | "reject");
}

// 1.8.2 (owner 17 Nov): Ask again on an expired proposal in History (owner only, checked again here). proposals-db
// askAgain decides whether it may (expired, alert still firing, no open copy); the new copy goes to Telegram like a
// new proposal, as a reply to its alert's message.
const ASK_AGAIN_REFUSED = {
  "not-expired": "Only an expired proposal can be asked again.",
  "alert-resolved": "Its alert isn't firing any more, so there's nothing to ask.",
  "already-waiting": "A copy of this proposal is already waiting for you.",
  superseded: "A newer copy of this proposal exists, so this one can't be asked again.",
  missing: "Unknown proposal.",
} as const;

export async function askAgainAction(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isProposalId(id)) return { ok: false, error: INVALID };
    const r = await askAgain(id, new Date());
    if (r.status !== "ok") return { ok: false, error: ASK_AGAIN_REFUSED[r.status] };
    const row = r.row;
    // 1.8.3 (final review 1.8.2, minors 4, 5 and 7): who asked again goes to Events; the Telegram send runs after the
    // answer (as Approve's history line does); the answer promises Telegram only when a chat is connected.
    await recordAction({ kind: "ok", message: `Asked again: ${row.title}`.slice(0, 200), resourceId: row.resourceId, actorUserId: member.userId }).catch(() => undefined);
    after(async () => {
      try {
        await notifyNewProposals([toProposal(row)], {}, { alertIds: new Map([[row.id, row.alertId ?? null]]) });
      } catch {
        // notifyNewProposals reports its own failures; the copy waits on the page either way
      }
    });
    const telegram = await telegramTarget().catch(() => null);
    const hours = Math.round(PROPOSAL_TTL_MS / 3_600_000);
    refresh();
    return { ok: true, message: `Asked again. It waits for you here${telegram ? " and on Telegram" : ""} for ${hours} hour${hours === 1 ? "" : "s"}.` };
  }, deps, "local");
}

export async function askAgainForm(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const v = form.get("id");
  return askAgainAction(typeof v === "string" ? v : "");
}
