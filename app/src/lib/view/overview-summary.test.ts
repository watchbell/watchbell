import { describe, expect, it } from "vitest";
import { overviewSummary } from "./overview-summary";

describe("overviewSummary (1.2.3, UI audit C2)", () => {
  it("says in one sentence whether everything is fine", () => {
    expect(overviewSummary(["ok", "ok", "build", "ok", "ok"], 0)).toBe("All 5 apps are up. Nothing needs you.");
    expect(overviewSummary(["ok"], 0)).toBe("The app is up. Nothing needs you.");
  });
  it("counts down and degraded apps and what needs the reader", () => {
    expect(overviewSummary(["ok", "err", "warn", "ok"], 2)).toBe("2 of 4 apps are up, 1 down, 1 degraded. 2 things need you; they are below.");
    expect(overviewSummary(["ok", "ok"], 1)).toBe("Both apps are up. 1 thing needs you; it is below.");
    expect(overviewSummary(["ok", "paused"], 0)).toBe("1 of 2 apps is up. Nothing needs you.");
  });
  it("nothing to say without apps", () => {
    expect(overviewSummary([], 3)).toBeNull();
  });
});
