import type { Graph, GraphNode } from "@/private/ai/usage-analytics";

// The provider graph (server-rendered SVG): Watchbell in the middle, a line to each source. A line is drawn in the
// accent when that source had traffic in the range, and thicker with a "running" label while Antigravity runs.

const nf = new Intl.NumberFormat("en");

function NodeBox({ n }: { n: GraphNode }) {
  const w = n.kind === "hub" ? 132 : 150;
  const h = n.kind === "hub" ? 46 : 40;
  const chips = (n.chips ?? []).slice(0, 4);
  return (
    <g>
      <rect x={n.x - w / 2} y={n.y - h / 2} width={w} height={h} rx={7}
        className={n.kind === "hub" ? "fill-ink stroke-ink" : "fill-surface stroke-line-strong"} strokeWidth={1} />
      <text x={n.x} y={n.y - 3} textAnchor="middle" className={n.kind === "hub" ? "fill-surface text-[13px] font-semibold" : "fill-ink text-[12.5px] font-medium"}>
        {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
      </text>
      <text x={n.x} y={n.y + 12} textAnchor="middle" className={n.kind === "hub" ? "fill-surface font-mono text-[10.5px] opacity-80" : "fill-ink-soft font-mono text-[10.5px]"}>
        {n.kind === "hub" ? n.sub : `${n.sub} · ${nf.format(n.requests)} req`}
      </text>
      {chips.map((c, i) => (
        <g key={c.id}>
          <rect x={n.x - w / 2} y={n.y + h / 2 + 4 + i * 17} width={w} height={14} rx={3}
            className={c.active ? "fill-brand-soft stroke-brand" : "fill-surface-2 stroke-line"} strokeWidth={0.75} />
          <text x={n.x} y={n.y + h / 2 + 14 + i * 17} textAnchor="middle" className={c.active ? "fill-brand font-mono text-[9.5px]" : "fill-ink-faint font-mono text-[9.5px]"}>
            {c.id.length > 26 ? `${c.id.slice(0, 25)}…` : c.id}
          </text>
        </g>
      ))}
      {(n.chips?.length ?? 0) > chips.length && (
        <text x={n.x} y={n.y + h / 2 + 14 + chips.length * 17} textAnchor="middle" className="fill-ink-faint text-[10px]">+{(n.chips?.length ?? 0) - chips.length} more</text>
      )}
    </g>
  );
}

export function UsageGraph({ graph }: { graph: Graph }) {
  const hub = graph.nodes[0];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const summary = graph.edges.map((e) => `${byId.get(e.to)?.label}: ${e.running ? "running" : e.active ? "traffic" : "no traffic"}`).join("; ");
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${graph.width} ${graph.height + 40}`} className="block h-auto w-full min-w-[560px]" role="img" aria-label={`Sources of AI traffic. ${summary}`}>
        {graph.edges.map((e) => {
          const n = byId.get(e.to);
          if (!n) return null;
          return (
            <g key={e.to}>
              <line x1={hub.x} y1={hub.y} x2={n.x} y2={n.y}
                className={e.active ? "stroke-brand" : "stroke-line-strong"} strokeWidth={e.running ? 3.5 : e.active ? 1.75 : 1} strokeDasharray={e.active ? undefined : "4 4"} />
              {e.running && (
                <text x={(hub.x + n.x) / 2} y={(hub.y + n.y) / 2 - 7} textAnchor="middle" className="fill-brand font-mono text-[11px] font-medium">running</text>
              )}
            </g>
          );
        })}
        {graph.nodes.map((n) => <NodeBox key={n.id} n={n} />)}
      </svg>
    </div>
  );
}
