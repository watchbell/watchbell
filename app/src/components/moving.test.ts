import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Moving, movingLabel } from "./moving";

// 1.8.1 (owner, 15 Nov): while a move runs, say where to, with a spinner.
describe("Moving", () => {
  it("says where things are going", () => {
    expect(movingLabel("test")).toBe("Moving to test…");
  });
  it("is a polite status with a spinner", () => {
    const out = renderToStaticMarkup(h(Moving, { to: "Kopi Senja" }));
    expect(out).toContain('role="status"');
    expect(out).toContain("animate-spin");
    expect(out).toContain("Moving to Kopi Senja…");
  });
});
