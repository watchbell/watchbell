"use client";

import { IconPlus, IconX } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { cn } from "@/lib/utils";
import { LIMIT_METRICS, LIMIT_WINDOWS, MAX_LIMITS } from "./limits";
import { saveLimits } from "./actions";

export type EditableProvider = { id: string; name: string; limits: { metric: string; scope: string; limit: number; window: string }[] };
type Draft = { metric: string; scope: string; limit: string; window: string };

const WINDOW_TEXT: Record<string, string> = { minute: "per minute", day: "per day", week: "per week" };

function ProviderLimits({ provider }: { provider: EditableProvider }) {
  const [rows, setRows] = useState<Draft[]>(() => provider.limits.map((l) => ({ ...l, limit: String(l.limit) })));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useHoldRefresh(dirty);

  const edit = (i: number, patch: Partial<Draft>) => { setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x))); setDirty(true); setError(null); };
  const save = () => start(async () => {
    try {
      const r = await saveLimits(provider.id, rows);
      if (r.ok) { toast.success(r.message ?? "Limits saved."); setDirty(false); setError(null); } else setError(r.error);
    } catch {
      setError("Something went wrong. Try again.");
    }
  });

  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 text-[13px] font-medium">{provider.name}</div>
      {rows.length === 0 && <p className="mb-2 text-[12.5px] text-ink-faint">No limits entered. Add one to count calls against it.</p>}
      {rows.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <select className={cn(fieldClass, "w-auto")} aria-label={`${provider.name} limit ${i + 1} metric`} value={r.metric} onChange={(e) => edit(i, { metric: e.target.value })}>
              {LIMIT_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select className={cn(fieldClass, "w-auto")} aria-label={`${provider.name} limit ${i + 1} window`} value={r.window} onChange={(e) => edit(i, { window: e.target.value })}>
              {LIMIT_WINDOWS.map((w) => <option key={w} value={w}>{WINDOW_TEXT[w]}</option>)}
            </select>
            <input className={cn(fieldClass, "w-[120px] font-mono")} inputMode="numeric" aria-label={`${provider.name} limit ${i + 1} value`} value={r.limit} onChange={(e) => edit(i, { limit: e.target.value })} />
            <input className={cn(fieldClass, "w-[150px] font-mono")} aria-label={`${provider.name} limit ${i + 1} model (all = every model)`} placeholder="model, or all" value={r.scope} onChange={(e) => edit(i, { scope: e.target.value })} />
          </div>
          <button type="button" aria-label={`Remove limit ${i + 1}`} className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" onClick={() => { setRows((x) => x.filter((_, n) => n !== i)); setDirty(true); setError(null); }}>
            <IconX size={15} aria-hidden />
          </button>
        </div>
      ))}
      {error && <p className="mb-2 text-[12.5px] text-err" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={rows.length >= MAX_LIMITS} onClick={() => { setRows((x) => [...x, { metric: "requests", scope: "all", limit: "", window: "day" }]); setDirty(true); }}>
          <IconPlus size={14} aria-hidden />Add limit
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty || pending} onClick={save}>{pending ? "Saving..." : "Save"}</Button>
      </div>
    </div>
  );
}

export function LimitsForm({ providers }: { providers: EditableProvider[] }) {
  return <>{providers.map((p) => <ProviderLimits key={p.id} provider={p} />)}</>;
}
