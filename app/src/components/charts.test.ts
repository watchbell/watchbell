import { describe, expect, it } from "vitest";
import { sparkColor } from "./charts";

describe("sparkColor (1.2.3)", () => {
  it("an error chart is red only when it has errors", () => {
    expect(sparkColor("err", [0, 0, null, 0])).toBe("text-ink-faint");
    expect(sparkColor("err", [0, 2, 0])).toBe("text-err");
    expect(sparkColor("accent", [0, 0])).toBe("text-brand");
  });
});
