import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { consoleVersion } from "@/lib/self-update";
import { VersionLabel } from "./version-label";

describe("VersionLabel (owner 13 Nov)", () => {
  it("names the running Watchbell and links its CHANGELOG section", () => {
    const out = renderToStaticMarkup(h(VersionLabel, { version: consoleVersion("1.6.0", true) }));
    expect(out).toContain("Watchbell 1.6.0");
    expect(out).toContain('href="https://github.com/watchbell/watchbell/blob/main/CHANGELOG.md#160"');
  });
  it("is plain text where nothing links out (demo), and nothing without a version", () => {
    const out = renderToStaticMarkup(h(VersionLabel, { version: consoleVersion("1.6.0", false) }));
    expect(out).toContain("Watchbell 1.6.0");
    expect(out).not.toContain("href");
    expect(consoleVersion(null, true)).toBeNull();
    expect(renderToStaticMarkup(h(VersionLabel, { version: null }))).toBe("");
  });
});
