"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { td, tableClass, TableHead } from "@/components/table";
import { RETENTION_CHOICES, RETENTION_KEYS, type RetentionDays, type RetentionKey } from "@/lib/settings/retention";
import { cn } from "@/lib/utils";
import { saveRetention } from "./actions";

// Mockup settings() → Retention: a select per table and Save. Only the fixed choices exist (lib/settings/retention.ts).
export function RetentionForm({ saved, rows }: { saved: RetentionDays; rows: { key: RetentionKey; kind: string; note: string }[] }) {
  const [value, setValue] = useState<RetentionDays>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const changed = RETENTION_KEYS.some((k) => value[k] !== saved[k]);
  function save() {
    start(async () => {
      const r = await saveRetention(Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(value[k])])));
      setErrors(r.ok ? {} : r.fieldErrors ?? {});
      if (r.ok) toast.success(r.message ?? "Saved.");
      else toast.error(r.error);
    });
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={["Data", "Kept for", "Notes"]} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className={td}><label htmlFor={`ret-${r.key}`}>{r.kind}</label></td>
                <td className={td}>
                  <select
                    id={`ret-${r.key}`} className={cn(fieldClass, "w-[130px]")} value={value[r.key]} aria-invalid={!!errors[r.key]}
                    onChange={(e) => setValue((v) => ({ ...v, [r.key]: Number(e.target.value) }))}
                  >
                    {RETENTION_CHOICES[r.key].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                  {errors[r.key] && <span className="mt-1 block text-[12.5px] text-err" role="alert">{errors[r.key]}</span>}
                </td>
                <td className={`${td} whitespace-normal text-ink-soft`}>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 px-[18px] py-3">
        <Button variant="primary" onClick={save} disabled={pending || !changed}>{pending ? "Saving…" : "Save"}</Button>
        {changed && <Button variant="ghost" onClick={() => { setValue(saved); setErrors({}); }}>Cancel</Button>}
      </div>
    </>
  );
}
