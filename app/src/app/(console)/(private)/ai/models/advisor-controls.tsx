"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Switch } from "@/private/ui/switch";
import { Thinking } from "@/private/slots/thinking";
import { runAdvisorNowAction, setAdvisorNotesAction } from "./actions";

// Models › Advisor notes (owner 14 Oct): on/off · model, and Run now. The notes are written by the owner's provider at
// 07:00 and 19:00 WIB (the owner's main app plus up to 3 apps that need attention) and show with the other AI notes.
export function AdvisorNotesControls({ enabled, model, models, defaultLabel }: { enabled: boolean; model: string | null; models: string[]; defaultLabel: string }) {
  const [on, setOn] = useState(enabled);
  const [pick, setPick] = useState(model ?? "");
  const [pending, start] = useTransition();
  const [running, startRun] = useTransition();

  const save = (nextOn: boolean, nextModel: string) => start(async () => {
    try {
      const r = await setAdvisorNotesAction(nextOn, nextModel || null);
      if (r.ok) toast.success(r.message ?? "Saved.");
      else { setOn(enabled); setPick(model ?? ""); toast.error(r.error); }
    } catch {
      toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
    }
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch checked={on} disabled={pending} label="Advisor notes" onChange={(next) => { setOn(next); save(next, pick); }} />
      <span className="text-[13px]">Advisor notes {on ? "on" : "off"}</span>
      <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
        <span className="sr-only">Advisor model</span>
        <select className={cn(fieldClass, "max-w-[260px] py-1 font-mono text-[12.5px]")} value={pick} disabled={pending} onChange={(e) => { setPick(e.target.value); save(on, e.target.value); }}>
          <option value="">Default ({defaultLabel})</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={running}
        onClick={() => startRun(async () => {
          try {
            const r = await runAdvisorNowAction();
            if (r.ok) toast.success(r.message ?? "Done."); else toast.error(r.error);
          } catch {
            toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
          }
        })}
      >
        <IconPlayerPlay size={15} aria-hidden />{running ? "Writing…" : "Run now"}
      </Button>
      {running && <Thinking />}
    </div>
  );
}
