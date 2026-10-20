"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { fieldClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Switch } from "@/private/ui/switch";
import { saveOfficeAutoRollback } from "./auto-run-actions";

type Value = { enabled: boolean; windowMin: number };

// Auto-rollback after a bad production deploy (owner 16 Oct): one switch and the window in minutes, saved on change.
export function AutoRollbackForm({ saved, choices }: { saved: Value; choices: number[] }) {
  const [value, setValue] = useState<Value>(saved);
  const [pending, start] = useTransition();
  const save = (next: Partial<Value>) => {
    const before = value;
    setValue((v) => ({ ...v, ...next }));
    start(async () => {
      try {
        const r = await saveOfficeAutoRollback(next);
        if (r.ok) { if (r.data) setValue(r.data); toast.success(r.message ?? "Saved."); }
        else { setValue(before); toast.error(r.error); }
      } catch {
        setValue(before);
        toast.error("Something went wrong. Try again.");
      }
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="inline-flex items-center gap-2">
        <Switch checked={value.enabled} disabled={pending} label="Auto-rollback when a new deploy errors" onChange={(enabled) => save({ enabled })} />
        <span className="text-[13px]">Auto-rollback when a new deploy errors (first <span className="font-mono">{value.windowMin}</span> minutes)</span>
      </span>
      <label className="inline-flex items-center gap-2 text-[13px] text-ink-soft">
        Window
        <select
          className={cn(fieldClass, "w-auto py-1")} value={value.windowMin} disabled={pending} aria-label="Auto-rollback window in minutes"
          onChange={(e) => save({ windowMin: Number(e.target.value) })}
        >
          {choices.map((m) => <option key={m} value={m}>{m} min</option>)}
        </select>
      </label>
    </div>
  );
}
