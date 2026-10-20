import { Sparkline } from "@/components/charts";
import { Card, Progress } from "@/components/kit";
import { Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { cn } from "@/lib/utils";
import type { ComputePanel } from "@/lib/view/usage";
import { MetricsKeyButtons } from "./metrics-key-dialog";

// Stage 12: the Compute panel under the project table. One block per watched project: with a metrics key, CPU, RAM,
// disk and connections now (Metrics API, every 5 min) with the last 24 hourly averages; without one, "Add metrics key"
// for the owner. Single-series sparklines (no legend: the label names them), numbers in ink, the bar's colour only for
// a share near its limit.

export type ComputeBlock = { id: string; name: string; alias: string; ref: string; paused: boolean; panel: ComputePanel };

const faint = "text-[12px] text-ink-faint";

export function ComputeCard({ blocks, owner }: { blocks: ComputeBlock[]; owner: boolean }) {
  if (!blocks.length) return null;
  return (
    <Card title="Compute" meta={<Src kind="api">Metrics API · 5 min</Src>}>
      <p className="mb-3 text-[12.5px] text-ink-soft">
        From Supabase&apos;s Metrics API (beta) with a per-project Secret API key the owner adds. Bars are now; the line is the hourly average over 24 h.
        Egress and monthly active users aren&apos;t readable per project through the Management API: see Usage in the Supabase dashboard.
      </p>
      <div className="flex flex-col divide-y divide-line">
        {blocks.map((b) => <Block key={b.id} b={b} owner={owner} />)}
      </div>
    </Card>
  );
}

function Block({ b, owner }: { b: ComputeBlock; owner: boolean }) {
  const p = b.panel;
  const hasKey = p.kind !== "none";
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Resource kind="db" name={b.name} dbId={b.id} />
        {p.kind === "ok" && <span className={cn(faint, p.stale && "text-warn")}>as of {p.asOf}{p.stale ? " · not updating" : ""}</span>}
        {owner && <span className="ml-auto"><MetricsKeyButtons id={b.id} projectRef={b.ref} alias={b.alias} hasKey={hasKey} /></span>}
      </div>
      {p.kind === "none" && (
        <p className="text-[13px] text-ink-soft">
          {b.paused ? "Paused: no compute to read. " : ""}No metrics key yet{owner ? ". Add one to see CPU, RAM, disk and connections." : ". An owner can add one."}
        </p>
      )}
      {p.kind === "waiting" && <p className="text-[13px] text-ink-soft">{p.note}</p>}
      {p.kind === "ok" && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 min-[1001px]:grid-cols-4">
            {p.gauges.map((g) => (
              <div key={g.label} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] text-ink-soft">{g.label}</span>
                  <span className="ml-auto font-mono text-[15px] font-semibold">{g.value}</span>
                </div>
                <Progress pct={g.pct ?? 0} tone={g.tone} />
                <div className="mt-1.5">
                  <Sparkline values={g.series} width={160} height={28} fluid label={`${g.label}, hourly average over the last 24 hours`} />
                </div>
                <div className={faint}>{g.peak ?? "24 h"}</div>
              </div>
            ))}
          </div>
          {p.error && <p className="mt-2 text-[12.5px] text-warn">Last scrape failed: {p.error}</p>}
        </>
      )}
    </div>
  );
}
