import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceChip } from "./workspace-chip";

// Watchbell 1.8 (spec §5, detail pages): a page for one thing names its workspace, whatever workspace is chosen.
describe("WorkspaceChip", () => {
  it("says which workspace the thing is in, and nothing without a name", () => {
    expect(renderToStaticMarkup(h(WorkspaceChip, { name: "Northwind" }))).toContain("in Northwind");
    expect(renderToStaticMarkup(h(WorkspaceChip, { name: null }))).toBe("");
  });
});
