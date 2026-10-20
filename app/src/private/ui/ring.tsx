import { cn } from "@/lib/utils";
import { ringPct, ringTone } from "./view";

// Antigravity-style usage ring (the mockup's .ring): a 22 px circle, the arc is what is left. Warn at 25 % or less, error at 10 %.
export function Ring({ pctLeft, size = 22 }: { pctLeft: number; size?: number }) {
  const pct = ringPct(pctLeft);
  const tone = ringTone(pct);
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg className="shrink-0" width={size} height={size} viewBox="0 0 22 22" role="img" aria-label={`${pct} % remaining`}>
      <circle cx="11" cy="11" r={r} fill="none" strokeWidth="3" className="stroke-sunken" />
      <circle
        cx="11" cy="11" r={r} fill="none" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${((c * pct) / 100).toFixed(1)} ${c.toFixed(1)}`}
        transform="rotate(-90 11 11)"
        className={cn(tone === "err" ? "stroke-err" : tone === "warn" ? "stroke-warn-icon" : "stroke-brand")}
      />
    </svg>
  );
}
