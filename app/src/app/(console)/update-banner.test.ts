import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./whats-new-dismiss", () => ({ WhatsNewDismiss: () => "[Got it]" }));

import { UpdateBanner } from "./update-banner";

describe("UpdateBanner (1.2.3)", () => {
  it("a newer version: how to update and a link to its CHANGELOG section", () => {
    const html = renderToStaticMarkup(h(UpdateBanner, { notice: { kind: "update", running: "1.2.3", latest: "1.2.4" } }));
    expect(html).toContain("Watchbell 1.2.4 is available (this is 1.2.3)");
    expect(html).toContain("watchbell update");
    expect(html).toContain("CHANGELOG.md#124");
    expect(html).not.toContain("[Got it]");
  });

  it("after an update: What's new with Got it", () => {
    const html = renderToStaticMarkup(h(UpdateBanner, { notice: { kind: "updated", version: "1.2.3" } }));
    expect(html).toContain("Updated to Watchbell 1.2.3");
    expect(html).toContain("CHANGELOG.md#123");
    expect(html).toContain("[Got it]");
  });

  it("nothing to say: nothing rendered", () => {
    expect(renderToStaticMarkup(h(UpdateBanner, { notice: null }))).toBe("");
  });
});
