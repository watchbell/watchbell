import { describe, expect, it } from "vitest";
import { hasRole } from "./roles";

describe("hasRole", () => {
  it("ranks owner > operator > viewer", () => {
    expect(hasRole("owner", "operator")).toBe(true);
    expect(hasRole("operator", "operator")).toBe(true);
    expect(hasRole("viewer", "operator")).toBe(false);
    expect(hasRole("operator", "owner")).toBe(false);
  });
});
