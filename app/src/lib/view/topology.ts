import type { State } from "@/lib/status";

// Topology (mockup drawTopo): three fixed columns, domain → app → database, drawn server-side. Boxes have a fixed
// size so the SVG lines can be computed without measuring the DOM. Mockup rule: an edge is "bad" (red, dashed) when
// it leaves an app that is down or failed, or enters a database that is down or paused; edges touching the selected
// node are "hot".

export type TopoKind = "dom" | "app" | "db" | "fs";
// A row of the drawer (mockup showNode): a label and its value, with a status icon when the value is a state.
export type TopoFact = { label: string; value: string; state?: State; mono?: boolean };
// `alias`: a database node's db-a (privacy). The box shows it; the drawer's heading reveals `name` on click.
export type TopoNode = { key: string; kind: TopoKind; name: string; alias?: string; sub: string; state: State; href: string; links: string[]; facts: TopoFact[] };
export type Placed = TopoNode & { col: 0 | 1 | 2; x: number; y: number };
export type Edge = { from: string; to: string; d: string; bad: boolean; hot: boolean };

export const NODE_W = 240;
export const NODE_H = 52;
export const GAP_X = 60;
export const GAP_Y = 12;
export const HEAD_H = 28;

export function layoutTopology(cols: [TopoNode[], TopoNode[], TopoNode[]], selected: string | null) {
  const nodes: Placed[] = cols.flatMap((list, col) => list.map((node, i) => ({
    ...node, col: col as 0 | 1 | 2, x: col * (NODE_W + GAP_X), y: HEAD_H + i * (NODE_H + GAP_Y),
  })));
  const byKey = new Map(nodes.map((p) => [p.key, p]));
  const edges: Edge[] = [];
  for (const a of nodes) {
    for (const key of a.links) {
      const b = byKey.get(key);
      if (!b) continue;
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
      edges.push({
        from: a.key, to: b.key, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        // The path only: app → database follows the database's own state, domain → app the domain and the app's website
        // checks (a background job that stopped pinging only makes the app Degraded, so it never colours an edge).
        bad: a.kind === "app" ? ["err", "paused"].includes(b.state) : ["err", "fail"].includes(a.state) || ["err", "paused"].includes(b.state),
        hot: selected !== null && (selected === a.key || selected === b.key),
      });
    }
  }
  const rows = Math.max(1, ...cols.map((c) => c.length));
  return { width: 3 * NODE_W + 2 * GAP_X, height: HEAD_H + rows * NODE_H + (rows - 1) * GAP_Y, nodes, edges };
}
