import { describe, expect, it } from "vitest";
import { readData, supabaseData } from "./snapshot-data";

describe("readData", () => {
  it("keeps known fields and drops what doesn't fit, never throwing", () => {
    expect(readData(supabaseData, { status: "INACTIVE", sizeBytes: 5, junk: 1 })).toEqual({ status: "INACTIVE", sizeBytes: 5 });
    expect(readData(supabaseData, { sizeBytes: "big" })).toEqual({});
    expect(readData(supabaseData, null)).toEqual({});
  });
});
