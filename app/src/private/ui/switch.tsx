"use client";

import { cn } from "@/lib/utils";

// The mockup's .switch: 32 x 18 track, brand when on. A button with role="switch" so a keyboard and a screen reader work.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-block h-[18px] w-8 shrink-0 rounded-[9px] align-middle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-brand" : "bg-line-strong",
      )}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-3.5 rounded-full bg-surface transition-transform", checked && "translate-x-3.5")} />
    </button>
  );
}
