import { describe, expect, it } from "vitest";
import { GAP_X, GAP_Y, HEAD_H, layoutTopology, NODE_H, NODE_W, type TopoNode } from "./topology";

const n = (key: string, kind: TopoNode["kind"], state: TopoNode["state"], links: string[] = []): TopoNode =>
  ({ key, kind, name: key, sub: "", state, href: `/x/${key}`, links, facts: [] });

describe("layoutTopology", () => {
  const cols: [TopoNode[], TopoNode[], TopoNode[]] = [
    [n("dom:a", "dom", "ok", ["app:1"]), n("dom:b", "dom", "warn", ["app:2"])],
    [n("app:1", "app", "ok", ["db:x"]), n("app:2", "app", "err", ["db:y"])],
    [n("db:x", "db", "ok"), n("db:y", "db", "paused")],
  ];
  it("places three columns of fixed boxes under a header row", () => {
    const l = layoutTopology(cols, null);
    expect(l.width).toBe(3 * NODE_W + 2 * GAP_X);
    expect(l.height).toBe(HEAD_H + 2 * NODE_H + GAP_Y);
    expect(l.nodes.find((p) => p.key === "app:2")).toMatchObject({ col: 1, x: NODE_W + GAP_X, y: HEAD_H + NODE_H + GAP_Y });
  });
  it("draws one bezier per link from the right edge to the left edge, middle of the boxes", () => {
    const e = layoutTopology(cols, null).edges.find((x) => x.from === "dom:a")!;
    const x1 = NODE_W, y1 = HEAD_H + NODE_H / 2, x2 = NODE_W + GAP_X, mx = (x1 + x2) / 2;
    expect(e.d).toBe(`M${x1},${y1} C${mx},${y1} ${mx},${y1} ${x2},${y1}`);
  });
  it("an edge from a broken app or to a paused database is bad; edges touching the selection are hot", () => {
    const l = layoutTopology(cols, "dom:a");
    expect(l.edges.find((x) => x.from === "app:2")!.bad).toBe(true);
    expect(l.edges.find((x) => x.from === "app:1")!.bad).toBe(false);
    expect(l.edges.find((x) => x.from === "dom:a")!.hot).toBe(true);
    expect(l.edges.find((x) => x.from === "app:1")!.hot).toBe(false);
  });
  it("an edge shows the path only: a database's state colours app → database, the app's website state domain → app", () => {
    const l = layoutTopology([
      [n("dom:a", "dom", "ok", ["app:1"]), n("dom:b", "dom", "ok", ["app:2"])],
      [n("app:1", "app", "warn", ["db:x"]), n("app:2", "app", "err", ["db:x"])],
      [n("db:x", "db", "ok")],
    ], null);
    // app:1 is Degraded (a background job isn't pinging, the website is up): no red edge in or out of it.
    expect(l.edges.find((x) => x.from === "dom:a")!.bad).toBe(false);
    expect(l.edges.find((x) => x.from === "app:1")!.bad).toBe(false);
    // app:2's website is down: the domain edge is red, the database edge stays calm because the database is fine.
    expect(l.edges.find((x) => x.from === "dom:b")!.bad).toBe(true);
    expect(l.edges.find((x) => x.from === "app:2")!.bad).toBe(false);
  });
  it("links to nodes that aren't on the page are dropped; empty columns still lay out", () => {
    const l = layoutTopology([[n("dom:a", "dom", "ok", ["app:zzz"])], [], []], null);
    expect(l.edges).toEqual([]);
    expect(l.height).toBe(HEAD_H + NODE_H);
  });
});
