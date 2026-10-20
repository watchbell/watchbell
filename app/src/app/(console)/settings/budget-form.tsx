"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, fieldClass } from "@/components/kit";
import { BUDGET_DEFAULTS, BUDGET_FIELDS, type BudgetLimits } from "@/lib/settings/budget";
import { cn } from "@/lib/utils";
import { resetBudget, saveBudget } from "./actions";

const ROW = "grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-b border-line py-2.5 last:border-b-0 max-[720px]:grid-cols-1 max-[720px]:gap-1";
const asText = (l: BudgetLimits) => Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, String(l[f.key])])) as Record<keyof BudgetLimits, string>;

// Stage 7 (B6): the published free limits and the warn/alarm percentages the table above uses. Owner only, audited.
export function BudgetForm({ saved }: { saved: BudgetLimits }) {
  const [value, setValue] = useState(asText(saved));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const changed = BUDGET_FIELDS.some((f) => value[f.key] !== String(saved[f.key]));
  const isDefault = BUDGET_FIELDS.every((f) => saved[f.key] === BUDGET_DEFAULTS[f.key]);
  function save() {
    start(async () => {
      const r = await saveBudget(value);
      setErrors(r.ok ? {} : r.fieldErrors ?? {});
      if (r.ok) toast.success(r.message ?? "Saved.");
      else toast.error(r.error);
    });
  }
  return (
    <div>
      {BUDGET_FIELDS.map((f) => (
        <div key={f.key} className={ROW}>
          <label htmlFor={`bud-${f.key}`} className="font-medium">
            {f.label}
            <span className="mt-0.5 block text-[12.5px] font-normal text-ink-soft">Published free limit: {BUDGET_DEFAULTS[f.key].toLocaleString("en-US")} {f.unit}</span>
          </label>
          <div className="min-w-0">
            <span className="flex items-center gap-2">
              <input
                id={`bud-${f.key}`} inputMode="numeric" className={cn(fieldClass, "w-[160px] font-mono text-[12.5px]")} value={value[f.key]} aria-invalid={!!errors[f.key]}
                onChange={(e) => setValue((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              <span className="text-[12.5px] text-ink-soft">{f.unit}</span>
            </span>
            {errors[f.key] && <span className="mt-1 block text-[12.5px] text-err" role="alert">{errors[f.key]}</span>}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Button variant="primary" onClick={save} disabled={pending || !changed}>{pending ? "Saving…" : "Save"}</Button>
        {changed && <Button variant="ghost" onClick={() => { setValue(asText(saved)); setErrors({}); }}>Cancel</Button>}
        {!isDefault && (
          <ConfirmDialog
            trigger={<Button>Reset to defaults</Button>}
            title="Reset the free tier limits?"
            body="The table goes back to the published free plans as last checked."
            cta="Reset"
            onConfirm={async () => {
              const r = await resetBudget();
              if (r.ok) setValue(asText(BUDGET_DEFAULTS));
              return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
            }}
          />
        )}
      </div>
    </div>
  );
}
