import { Sparkline } from "@/components/charts";
import { Card } from "@/components/kit";
import { Src } from "@/components/sources";
import type { Health } from "@/lib/data/metrics-db";
import { healthRows } from "@/lib/view/health";

// Mockup section 1 → Health: label + source, big value + unit, a fluid 300×30 sparkline of 30 points over 24 h.
export function HealthCard({ health: h }: { health: Health }) {
  return (
    <Card title="Health" meta="Last 24 hours">
      {healthRows(h).map((r) => (
        <div key={r.label} className="grid grid-cols-[130px_92px_minmax(0,1fr)] items-center gap-3 border-b border-line py-[9px] last:border-b-0">
          <span>{r.label}<Src kind={r.src} /></span>
          <span className="text-[17px] font-semibold">{r.value}{r.unit && <small className="text-xs font-normal text-ink-soft"> {r.unit}</small>}</span>
          <Sparkline values={r.series} width={300} height={30} fluid label={`${r.label}, last 24 hours`} />
        </div>
      ))}
    </Card>
  );
}
