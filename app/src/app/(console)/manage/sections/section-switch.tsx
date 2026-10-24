"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { setSectionOn } from "./actions";

// on: shown; off: turned off by hand; waiting: an automatic section with nothing connected yet (off and disabled).
export type SwitchState = "on" | "off" | "waiting";

// The mockup's switch (a checkbox styled as a toggle), as on AI Gateway › Bring your own key. Turning a section off
// asks first and says what stops (`stops`); turning it on is one click.
export function SectionSwitch({ section, label, state, stops }: { section: string; label: string; state: SwitchState; stops: string }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(state === "on");
  const [confirm, setConfirm] = useState(false);
  const waiting = state === "waiting";
  return (
    <>
      <label className={`relative inline-flex items-center ${waiting ? "cursor-not-allowed" : "cursor-pointer"}`} title={`${label}: ${waiting ? "not connected yet" : value ? "on" : "off"}`}>
        <input
          type="checkbox" role="switch" className="peer sr-only" checked={value} disabled={pending || waiting} aria-label={`${label} section`}
          onChange={(e) => {
            if (!e.target.checked) {
              setConfirm(true);
              return;
            }
            setValue(true);
            start(async () => {
              const r = await setSectionOn(section, true);
              if (!r.ok) {
                setValue(false);
                toast.error(r.error);
              } else toast.success(r.message ?? "Saved.");
            });
          }}
        />
        <span className="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 peer-disabled:opacity-60" />
        <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-surface transition-transform peer-checked:translate-x-4" />
      </label>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Turn ${label} off?`}
        body={`${stops} Its data is kept.`}
        cta={`Turn ${label} off`}
        danger={section === "hosting"}
        onConfirm={async () => {
          const r = await setSectionOn(section, false);
          if (r.ok) setValue(false);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
    </>
  );
}
