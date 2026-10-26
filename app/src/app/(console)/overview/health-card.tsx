import { Sparkline } from "@/components/charts";
import { Card } from "@/components/kit";
import { Src } from "@/components/sources";
import type { Health } from "@/lib/data/metrics-db";
import { healthRows } from "@/lib/view/health";

// Mockup section 1 → Health: label + source, a plain-words line under the label (its technical name is the tooltip),
// big value + unit, a fluid 300×30 sparkline of 30 points over 24 h. On a narrow screen the sparkline drops under the row.
export function HealthCard({ health: h }: { health: Health }) {
  return (
    <Card title="Health" meta="Last 24 hours">
      {healthRows(h).map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,2fr)_92px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-b border-line py-[9px] last:border-b-0 max-[640px]:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div>{r.label}<Src kind={r.src}>{r.srcText}</Src></div>
            <div className="text-xs text-ink-soft" title={r.term}>{r.hint}<span className="sr-only"> ({r.term})</span></div>
          </div>
          <span className="text-[17px] font-semibold">{r.value}{r.unit && <small className="text-xs font-normal text-ink-soft"> {r.unit}</small>}</span>
          <div className="max-[640px]:col-span-2"><Sparkline values={r.series} width={300} height={30} fluid label={`${r.label}, last 24 hours`} /></div>
        </div>
      ))}
    </Card>
  );
}
