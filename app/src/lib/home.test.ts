import { describe, expect, it } from "vitest";
import { homePath } from "./home";

describe("homePath", () => {
  it("sends owners to the first-run page until something is connected", () => {
    expect(homePath({ role: "owner", accountCount: 0 })).toBe("/welcome");
  });
  it("sends owners to the overview once an account exists", () => {
    expect(homePath({ role: "owner", accountCount: 2 })).toBe("/overview");
  });
  it("sends everyone else to the overview", () => {
    expect(homePath({ role: "viewer", accountCount: 0 })).toBe("/overview");
    expect(homePath({ role: "operator", accountCount: 3 })).toBe("/overview");
  });
});
