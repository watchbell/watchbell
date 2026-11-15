import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnsortedNote } from "./unsorted-note";

// Watchbell 1.8 (spec §5, New things): Overview and Applications say when new things wait to be sorted.
describe("UnsortedNote", () => {
  it("links to the list when there are some, and says nothing otherwise", () => {
    const out = renderToStaticMarkup(h(UnsortedNote, { count: 3 }));
    expect(out).toContain("3 new, not sorted");
    expect(out).toContain('href="/workspaces#unsorted"');
    expect(renderToStaticMarkup(h(UnsortedNote, { count: 1 }))).toContain("1 new, not sorted");
    expect(renderToStaticMarkup(h(UnsortedNote, { count: 0 }))).toBe("");
  });
});
