import { cn } from "@/lib/utils";
import { sparkPaths, sparkRange } from "@/lib/view/spark";
import { pageViewBars } from "@/lib/view/pageviews";
import type { Bar } from "@/lib/view/uptime";

// The mockup's spark(): area at 12% opacity under a 1.5 px line. Fluid charts stretch to the card's width.
// Two optional extras (the app page's Response time chart, mockup respChart): `second`, a dashed line on the same
// scale (p50 under p95, A6), and `ticks`, thin vertical lines with a tooltip (production deploys, A1). With either, a
// small legend follows the chart.
// 1.2.3 (owner 26 Oct): an error chart with nothing in it (5xx = 0) is drawn grey, not red, so a quiet app doesn't
// look broken at a glance.
export const sparkColor = (tone: "accent" | "err", values: (number | null)[]): string =>
  tone === "err" ? (values.some((v) => (v ?? 0) > 0) ? "text-err" : "text-ink-faint") : "text-brand";

export function Sparkline({
  values, second, ticks = [], width, height, tone = "accent", fluid = false, label,
}: {
  values: (number | null)[]; second?: (number | null)[]; ticks?: { x: number; title: string }[];
  width: number; height: number; tone?: "accent" | "err"; fluid?: boolean; label: string;
}) {
  const range = sparkRange(values, second ?? []);
  const { line, area, dots } = sparkPaths(values, width, height, range);
  const median = second ? sparkPaths(second, width, height, range) : null;
  const color = sparkColor(tone, values);
  const paths = (
    <>
      {ticks.map((t) => <line key={`${t.x}-${t.title}`} x1={t.x} x2={t.x} y1={0} y2={height} className="stroke-ink-faint" strokeWidth={1} vectorEffect="non-scaling-stroke"><title>{t.title}</title></line>)}
      {area && <path d={area} fill="currentColor" opacity={0.12} />}
      {line && <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      {median?.line && <path d={median.line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} vectorEffect="non-scaling-stroke" />}
      {/* a zero-length round-capped stroke is a dot of 3 px that stays round when a fluid chart is stretched */}
      {dots.map((d) => <path key={`${d.x},${d.y}`} d={`M${d.x},${d.y}h0`} stroke="currentColor" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
      {median?.dots.map((d) => <path key={`m${d.x},${d.y}`} d={`M${d.x},${d.y}h0`} stroke="currentColor" strokeWidth={3} strokeLinecap="round" opacity={0.7} vectorEffect="non-scaling-stroke" />)}
    </>
  );
  const svg = fluid ? (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={label} className={cn("block", color)}>{paths}</svg>
  ) : (
    <svg width={width} height={height} role="img" aria-label={label} className={cn("block", color)}>{paths}</svg>
  );
  if (!second && !ticks.length) return svg;
  return (
    <>
      {svg}
      <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-ink-soft">
        <span><i className="mr-[5px] inline-block w-3.5 border-t-2 border-current align-middle" />p95</span>
        {second && <span><i className="mr-[5px] inline-block w-3.5 border-t-2 border-dashed border-current align-middle" />p50</span>}
        {ticks.length > 0 && <span><i className="mr-[5px] inline-block h-2.5 border-l border-ink-faint align-middle" />Production deploy</span>}
      </div>
    </>
  );
}

// U5: a day of only maintenance checks is brand blue at low strength (the mockup's .bar.maint).
const BAR_TONE = { none: "bg-line-strong opacity-85", ok: "bg-ok opacity-85", warn: "bg-warn-icon opacity-85", err: "bg-err opacity-85", maint: "bg-brand opacity-45" } as const;

// The mockup's 90-day strip: one bar per WIB day, oldest left, each with a tooltip. Grey means no data (R3). A dark
// notch on top marks a day with a production deploy (A1).
export function UptimeBars({ bars }: { bars: Bar[] }) {
  const n = (t: Bar["tone"]) => bars.filter((b) => b.tone === t).length;
  const deploys = bars.filter((b) => b.deploy).length;
  const summary = `Last ${bars.length} days: ${n("ok")} without failures, ${n("warn")} with 1 or 2 failed checks, ${n("err")} with 3 or more, ${n("none")} without data, ${n("maint")} with only maintenance, ${deploys} with a production deploy`;
  return (
    <div className="flex h-6 min-w-[280px] gap-0.5" role="img" aria-label={summary}>
      {bars.map((b) => <span key={b.day} title={b.title} className={cn("flex-1 rounded-[1px]", BAR_TONE[b.tone], b.deploy && "shadow-[inset_0_3px_0_var(--color-ink)]")} />)}
    </div>
  );
}

// AI › Usage: one stacked bar per bucket (hour or WIB day), oldest left, each with a tooltip; parts stack bottom-up in
// the order of `parts`, each its own strength of the accent. Same 1 px baseline for an empty slot as HourBars.
const STACK_TONE = ["bg-brand opacity-90", "bg-brand opacity-35", "bg-ink-soft opacity-70"] as const;
export function StackedBars({
  bars, parts, height, label,
}: { bars: { key: string; title: string; values: number[] }[]; parts: string[]; height: number; label: string }) {
  const max = Math.max(1, ...bars.map((b) => b.values.reduce((s, v) => s + v, 0)));
  return (
    <>
      <div className="flex items-end gap-0.5" style={{ height }} role="img" aria-label={label}>
        {bars.map((b) => {
          const total = b.values.reduce((s, v) => s + v, 0);
          return (
            <span key={b.key} title={b.title} className="flex h-full min-w-0 flex-1 flex-col-reverse">
              {total === 0 ? <span className="block h-px w-full bg-line-strong" /> : b.values.map((v, i) => (
                v > 0 && <span key={parts[i]} className={cn("block w-full first:rounded-b-[1px] last:rounded-t-[1px]", STACK_TONE[i % STACK_TONE.length])} style={{ height: `${(v / max) * 100}%` }} />
              ))}
            </span>
          );
        })}
      </div>
      {parts.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-ink-soft">
          {parts.map((p, i) => <span key={p}><i className={cn("mr-[5px] inline-block size-2.5 rounded-[2px] align-middle", STACK_TONE[i % STACK_TONE.length])} />{p}</span>)}
        </div>
      )}
    </>
  );
}

// Page views: one bar per hour of the last 24 h, oldest left, each with a tooltip (WIB hour and count). Same colour as the
// other metric charts; an hour with no views keeps a 1 px baseline so the 24 slots always read as a series.
export function HourBars({ hours, height, label }: { hours: { at: Date; views: number }[]; height: number; label: string }) {
  const bars = pageViewBars(hours);
  return (
    <div className="flex items-end gap-0.5 text-brand" style={{ height }} role="img" aria-label={label}>
      {bars.map((b) => (
        <span key={b.key} title={b.title} className="flex h-full flex-1 items-end">
          <span className={cn("block w-full rounded-[1px]", b.pct ? "bg-current opacity-85" : "bg-line-strong")} style={{ height: b.pct ? `${b.pct}%` : 1 }} />
        </span>
      ))}
    </div>
  );
}
