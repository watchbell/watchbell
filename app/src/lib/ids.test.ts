import { describe, expect, it } from "vitest";
import { isUuid } from "./ids";

describe("isUuid", () => {
  it("accepts a database id and nothing else", () => {
    expect(isUuid("3f2a1b4c-0d9e-4f8a-9b7c-1a2b3c4d5e6f")).toBe(true);
    expect(isUuid("portfolio-site")).toBe(false);
    expect(isUuid("3f2a1b4c-0d9e-4f8a-9b7c-1a2b3c4d5e6f'; drop table x")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
