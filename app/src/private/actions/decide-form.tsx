"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/kit";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";
import { decideProposalForm } from "./page-actions";

// Approve / Reject for one waiting proposal: one small form, the pressed button names the decision. Works before
// hydration too (a plain form post); afterwards the answer shows beside the buttons until the refreshed list moves it.
export function DecideForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(decideProposalForm, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <button type="submit" name="decision" value="approve" disabled={pending} className={buttonClass({ variant: "primary", size: "sm" })}>
        Approve
      </button>
      <button type="submit" name="decision" value="reject" disabled={pending} className={buttonClass({ size: "sm" })}>
        Reject
      </button>
      {pending && <span className="text-[12.5px] text-ink-soft" role="status">Working…</span>}
      {!pending && state && (
        <span className={cn("text-[12.5px]", state.ok ? "text-ink-soft" : "text-err")} role={state.ok ? "status" : "alert"}>
          {state.ok ? state.message : state.error}
        </span>
      )}
    </form>
  );
}
