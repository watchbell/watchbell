import { describe, expect, it } from "vitest";
import { freshIds } from "./fresh";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("freshIds", () => {
  it("flashes nothing for rows that were there when the page opened", () => {
    expect(freshIds(new Set(["a", "b", "c"]), new Set(), rows).size).toBe(0);
  });
  it("flashes rows that arrived after the page opened", () => {
    expect([...freshIds(new Set(["b", "c"]), new Set(), rows)]).toEqual(["a"]);
  });
  it("does not flash a row again once its animation has ended", () => {
    expect(freshIds(new Set(["c"]), new Set(["a"]), rows).has("a")).toBe(false);
    expect([...freshIds(new Set(["c"]), new Set(["a"]), rows)]).toEqual(["b"]);
  });
  it("flashes every row when the page opened empty", () => {
    expect([...freshIds(new Set(), new Set(), rows)]).toEqual(["a", "b", "c"]);
  });
});
