"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { type AgLimitKey, LIMIT_FIELDS } from "@/private/ai/agent-usage";
import { saveAgLimits } from "./actions";

// The owner's own numbers for Antigravity's limits (tokens: new input + output + thinking; cached excluded). Blank =
// no limit entered. The server checks every value again.
export function LimitsForm({ values }: { values: Record<AgLimitKey, number | null> }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  if (!open) {
    return <Button size="sm" onClick={() => setOpen(true)}>Edit limits</Button>;
  }
  return (
    <form
      className="flex flex-col gap-2"
      action={(form) => start(async () => {
        try {
          const r = await saveAgLimits(form);
          if (r.ok) { toast.success(r.message ?? "Saved."); setOpen(false); } else toast.error(r.error);
        } catch {
          toast.error("Something went wrong. Try again.");
        }
      })}
    >
      {LIMIT_FIELDS.map((f) => (
        <label key={f.key} className="flex items-center gap-2 text-[13px]">
          <span className="w-28 shrink-0 text-ink-soft">{f.label}</span>
          <input
            name={f.key}
            inputMode="numeric"
            autoComplete="off"
            placeholder="No limit"
            defaultValue={values[f.key] ?? ""}
            className={cn(fieldClass, "min-w-0 flex-1 py-1 text-right font-mono text-[12.5px]")}
            aria-label={`${f.label} limit in tokens`}
          />
        </label>
      ))}
      <p className="m-0 text-[12px] text-ink-faint">Tokens per window: new input + output + thinking. Cached input isn&apos;t counted.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button size="sm" type="button" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
