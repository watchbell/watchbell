import { describe, expect, it } from "vitest";
import { ALL_WORKSPACES, pickWorkspace, switcherEntries, workspaceLabel } from "./choice";

const P = { id: "00000000-0000-4000-8000-00000000f001", name: "Personal" };
const K = { id: "00000000-0000-4000-8000-0000000000b1", name: "Kopi Senja" };

// Watchbell 1.8 (spec §5; Review Focus 3).
describe("pickWorkspace", () => {
  it("takes the cookie's workspace, falls back to the first for an unknown or deleted one, and none when unset", () => {
    expect(pickWorkspace(K.id, [P, K])).toBe(K.id);
    expect(pickWorkspace("00000000-0000-4000-8000-0000000000ff", [P, K])).toBe(P.id);
    expect(pickWorkspace("garbage", [P, K])).toBe(P.id);
    expect(pickWorkspace(undefined, [P, K])).toBe(P.id);
  });

  it("All workspaces is null, and means the only one when there is one", () => {
    expect(pickWorkspace(ALL_WORKSPACES, [P, K])).toBeNull();
    expect(pickWorkspace(ALL_WORKSPACES, [P])).toBe(P.id);
  });
});

describe("switcherEntries", () => {
  it("checks the current workspace and adds All workspaces when there are several", () => {
    expect(switcherEntries([P, K], K.id)).toEqual([
      { value: P.id, label: "Personal", checked: false },
      { value: K.id, label: "Kopi Senja", checked: true },
      { value: "all", label: "All workspaces", checked: false },
    ]);
    expect(switcherEntries([P], P.id)).toEqual([{ value: P.id, label: "Personal", checked: true }]);
    expect(workspaceLabel([P, K], null)).toBe("All workspaces");
    expect(workspaceLabel([P, K], K.id)).toBe("Kopi Senja");
  });
});
