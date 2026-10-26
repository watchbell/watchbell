"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { td, tableClass, TableHead } from "@/components/table";
import { Switch } from "@/private/ui/switch";
import { saveOfficeAutoRun } from "./auto-run-actions";
import type { AutoRun, ProposalAction } from "./proposals-types";

type Row = { kind: ProposalAction; label: string; risky: boolean; what: string };

// One switch per safe kind, saved as soon as it flips (like the model switches); risky kinds show the rule instead.
export function AutoRunForm({ saved, rows }: { saved: AutoRun; rows: Row[] }) {
  const [value, setValue] = useState<AutoRun>(saved);
  const [pending, start] = useTransition();
  const flip = (kind: ProposalAction, next: boolean) => {
    setValue((v) => ({ ...v, [kind]: next }));
    start(async () => {
      try {
        const r = await saveOfficeAutoRun({ [kind]: next });
        if (r.ok) { if (r.data) setValue(r.data); toast.success(r.message ?? "Saved."); }
        else { setValue((v) => ({ ...v, [kind]: !next })); toast.error(r.error); }
      } catch {
        setValue((v) => ({ ...v, [kind]: !next }));
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  };
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <TableHead head={["Action", "Auto-run", "What it does"]} />
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind}>
              <td className={td}>{r.label}</td>
              <td className={td}>
                {r.risky
                  ? <span className="text-[12.5px] text-ink-soft">selalu minta persetujuan</span>
                  : (
                    <span className="inline-flex items-center gap-2">
                      <Switch checked={value[r.kind]} disabled={pending} label={`Auto-run: ${r.label}`} onChange={(next) => flip(r.kind, next)} />
                      <span className="text-[13px]">{value[r.kind] ? "On" : "Off"}</span>
                    </span>
                  )}
              </td>
              <td className={`${td} whitespace-normal text-ink-soft`}>{r.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
