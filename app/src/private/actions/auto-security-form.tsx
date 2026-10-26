"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/private/ui/switch";
import { saveOfficeAutoSecurity } from "./auto-run-actions";

type Level = "critical" | "high" | "moderate";
type Value = { enabled: boolean; severities: Level[]; sameMajorOnly: true };
const LEVELS: { level: Level; label: string }[] = [{ level: "critical", label: "Critical" }, { level: "high", label: "High" }, { level: "moderate", label: "Moderate" }];

// Automatic security fixes (owner 16 Oct): the main switch and one switch per severity, saved on change. Watchbell 1.2.1:
// Moderate sits next to Critical and High (owner 1a); low and unknown advisories are never fixed automatically.
export function AutoSecurityForm({ saved, rollbackOn }: { saved: Value; rollbackOn: boolean }) {
  const [value, setValue] = useState<Value>(saved);
  const [pending, start] = useTransition();
  const save = (next: Partial<Value>) => {
    const before = value;
    setValue((v) => ({ ...v, ...next }));
    start(async () => {
      try {
        const r = await saveOfficeAutoSecurity(next);
        if (r.ok) { if (r.data) setValue(r.data as Value); toast.success(r.message ?? "Saved."); }
        else { setValue(before); toast.error(r.error); }
      } catch {
        setValue(before);
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  };
  const flipLevel = (level: Level, on: boolean) => save({ severities: LEVELS.map((l) => l.level).filter((l) => (l === level ? on : value.severities.includes(l))) });
  return (
    <div className="flex flex-col gap-2">
      <span className="inline-flex items-center gap-2">
        <Switch checked={value.enabled} disabled={pending} label="Automatic security fixes" onChange={(enabled) => save({ enabled })} />
        <span className="text-[13px]">Automatic security fixes {value.enabled ? "on" : "off"}</span>
      </span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
        <span>For advisories:</span>
        {LEVELS.map((l) => (
          <span key={l.level} className="inline-flex items-center gap-2">
            <Switch checked={value.severities.includes(l.level)} disabled={pending || !value.enabled} label={`Severity ${l.label}`} onChange={(on) => flipLevel(l.level, on)} />
            {l.label}
          </span>
        ))}
        <span>· major updates always wait for you</span>
      </div>
      {value.enabled && !rollbackOn && (
        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px] text-warn" role="status">
          Without auto-rollback, the PR is opened automatically but the merge waits for you.
        </p>
      )}
    </div>
  );
}
