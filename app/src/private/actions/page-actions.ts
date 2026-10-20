"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { isProposalId } from "./proposals";
import { decideAndRun } from "./proposals-decide";

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
