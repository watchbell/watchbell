// SVG paths for a sparkline: the line and the shaded area under it, scaled like the mockup's spark() (3 px of
// padding above and below). An empty bucket (null) leaves a gap; with no numbers there is nothing to draw. A segment of
// one point has no line to draw, so it comes back as a dot (the caller draws a 3 px round-capped stroke there) and the first data
// point shows. A dot's x is kept 1.5 px inside the box so the first and last bucket aren't clipped by half.
const DOT_R = 1.5;

// One scale for two series (p50 under p95, A6): the min and max over all of them, gaps ignored; null without numbers.
export function sparkRange(...series: (number | null)[][]): { min: number; max: number } | null {
  const nums = series.flat().filter((v): v is number => v !== null);
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null;
}

export function sparkPaths(values: (number | null)[], w: number, h: number, range?: { min: number; max: number } | null): { line: string; area: string; dots: { x: number; y: number }[] } {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return { line: "", area: "", dots: [] };
  const max = range?.max ?? Math.max(...nums);
  const min = range?.min ?? Math.min(...nums);
  const span = max - min || 1;
  const last = Math.max(1, values.length - 1);
  const x = (i: number) => ((i / last) * w).toFixed(1);
  const y = (v: number) => (h - 3 - ((v - min) / span) * (h - 6)).toFixed(1);
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push([i, v]);
    }
  });
  if (current.length) segments.push(current);
  const path = (s: [number, number][]) => s.map(([i, v], k) => `${k ? "L" : "M"}${x(i)},${y(v)}`).join("");
  return {
    line: segments.map(path).join(""),
    area: segments.filter((s) => s.length > 1).map((s) => `${path(s)}L${x(s[s.length - 1][0])},${h}L${x(s[0][0])},${h}Z`).join(""),
    dots: segments.filter((s) => s.length === 1).map(([[i, v]]) => ({ x: Math.min(Math.max(Number(x(i)), DOT_R), Math.max(w - DOT_R, DOT_R)), y: Number(y(v)) })),
  };
}
