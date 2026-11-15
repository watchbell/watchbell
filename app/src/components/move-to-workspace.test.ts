import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(console)/workspaces/actions", () => ({ moveToWorkspace: vi.fn() }));

import { MoveToWorkspace, moveTargets } from "./move-to-workspace";

const P = { id: "p", name: "Personal" };
const K = { id: "k", name: "Kopi Senja" };

// Watchbell 1.8 (spec §5, Moving).
describe("MoveToWorkspace", () => {
  it("offers the move when there is somewhere to move to and something to move", () => {
    expect(renderToStaticMarkup(h(MoveToWorkspace, { kind: "resource", items: [{ id: "a", name: "shop" }], workspaces: [P, K], current: P.id }))).toContain("Move to workspace");
    expect(renderToStaticMarkup(h(MoveToWorkspace, { kind: "resource", items: [{ id: "a", name: "shop" }], workspaces: [P], current: P.id }))).toBe("");
    expect(renderToStaticMarkup(h(MoveToWorkspace, { kind: "resource", items: [], workspaces: [P, K], current: P.id }))).toBe("");
  });

  it("targets every workspace but the one shown", () => {
    expect(moveTargets([P, K], P.id)).toEqual([K]);
    expect(moveTargets([P, K], null)).toEqual([P, K]);
  });
});
