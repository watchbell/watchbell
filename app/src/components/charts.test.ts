import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sparkColor, StackedBars } from "./charts";

describe("sparkColor (1.2.3)", () => {
  it("an error chart is red only when it has errors", () => {
    expect(sparkColor("err", [0, 0, null, 0])).toBe("text-ink-faint");
    expect(sparkColor("err", [0, 2, 0])).toBe("text-err");
    expect(sparkColor("accent", [0, 0])).toBe("text-brand");
  });
});

describe("StackedBars with a fixed scale (owner 13 Nov: memory against total RAM)", () => {
  it("scales the parts to the given max, so the free share stays visible", () => {
    const out = renderToStaticMarkup(h(StackedBars, { bars: [{ key: "a", title: "t", values: [25, 25, 0] }], parts: ["Used", "Cache", "Swap"], height: 40, label: "x", max: 100 }));
    expect(out.match(/height:25%/g)).toHaveLength(2);
  });
  it("without a max, the tallest bar fills the chart as before", () => {
    const out = renderToStaticMarkup(h(StackedBars, { bars: [{ key: "a", title: "t", values: [25, 25] }], parts: ["A", "B"], height: 40, label: "x" }));
    expect(out.match(/height:50%/g)).toHaveLength(2);
  });
});
