"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { MaskedText } from "@/components/alias";
import { StateIcon, Status } from "@/components/status";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { State } from "@/lib/status";
import { ago } from "@/lib/time";
import { onlyJobs, type Problem, whyTitle } from "@/lib/view/why";

// The app's status as a button that says WHERE the problem is and HOW to handle it (lib/view/why.ts). An app with
// nothing to explain (Running, Maintenance, Building…) keeps plain text. Names go through the page's masks.
// `aiSlot` (5c, owner only): the private feature's "Ask AI" block, rendered by the server page under the problems.
export function WhyStatus({ state, label, problems, nowMs, aiSlot = null }: { state: State; label: string; problems: Problem[]; nowMs: number; aiSlot?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!problems.length || (state !== "warn" && state !== "err")) return <Status state={state}>{label}</Status>;
  const now = new Date(nowMs);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        title="Why? Where the problem is and what to do"
        className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-transparent p-0 text-left text-inherit underline decoration-dotted decoration-1 underline-offset-[3px] hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 [font:inherit]"
      >
        <StateIcon state={state} /><span>{label}</span>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-[520px]">
        <DialogTitle className="flex items-center gap-2 text-base"><StateIcon state={state} />{whyTitle(state)}</DialogTitle>
        <DialogDescription className="text-[13px] text-ink-soft">
          {onlyJobs(problems) ? "The website is up; a background job isn't reporting." : `${problems.length === 1 ? "One thing explains" : `${problems.length} things explain`} this status.`}
        </DialogDescription>
        <div className="flex flex-col gap-4">
          {problems.map((p, i) => (
            <section key={`${p.where}-${i}`} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <h3 className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-medium">
                <StateIcon state={p.state} />
                <Link href={p.href} onClick={() => setOpen(false)}><MaskedText text={p.where} /></Link>
              </h3>
              <p className="mt-1 text-[13px] text-ink-soft">
                <MaskedText text={p.reason} />{p.since ? <> · since {ago(p.since, now)}</> : null}
              </p>
              <p className="mt-2 text-[12px] font-medium uppercase tracking-[0.04em] text-ink-faint">What to do</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px]">
                {p.remedies.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </section>
          ))}
        </div>
        {aiSlot}
      </DialogContent>
    </Dialog>
  );
}
