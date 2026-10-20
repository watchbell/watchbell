import { describe, expect, it } from "vitest";
import { rowsOf } from "./rows";

describe("rowsOf", () => {
  it("returns a postgres.js row list as is", () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
  it("unwraps the rows of a PGlite result", () => {
    expect(rowsOf({ rows: [{ a: 1 }], fields: [] })).toEqual([{ a: 1 }]);
  });
  it("gives an empty list for null or a result without rows", () => {
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf({ count: 3 })).toEqual([]);
  });
});
