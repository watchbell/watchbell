import { describe, expect, it } from "vitest";
import { filterByWorkspace, workspacePrefix } from "./alerts";

// Watchbell 1.8 (spec §5): the Alerts page shows the chosen workspace's alerts and the install's own, and says how many
// are open elsewhere; alert and digest texts name the workspace when there is more than one.
describe("filterByWorkspace", () => {
  const rows = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "i1" }];
  const wsOf = new Map([["a1", "A"], ["a2", "B"], ["a3", "B"]]);
  it("keeps the workspace's rows and the install's, and counts the rest", () => {
    expect(filterByWorkspace(rows, wsOf, "A")).toEqual({ shown: [{ id: "a1" }, { id: "i1" }], elsewhere: 2 });
    expect(filterByWorkspace(rows, wsOf, null)).toEqual({ shown: rows, elsewhere: 0 });
  });
});

describe("workspacePrefix", () => {
  it("names the workspace only when there are several", () => {
    expect(workspacePrefix("Kopi Senja", 2)).toBe("[Kopi Senja] ");
    expect(workspacePrefix("Kopi Senja", 1)).toBe("");
    expect(workspacePrefix(null, 3)).toBe("");
  });
});
