import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../vercel-actions", () => ({ buildLogsAction: vi.fn() }));

import { DEMO_BUILD_LOG } from "@/lib/view/build-logs";
import { BuildLogBody, lineId } from "./build-logs-drawer";

describe("BuildLogBody (Task 4 build logs)", () => {
  it("highlights the error lines and links to the first one", () => {
    const html = renderToStaticMarkup(h(BuildLogBody, { log: DEMO_BUILD_LOG }));
    const first = DEMO_BUILD_LOG.lines.findIndex((l) => l.text === "Failed to compile.");
    expect(html).toContain(`data-line="${lineId(first)}"`);
    expect(html).not.toContain('href="#');
    expect(html).toContain("Jump to first error");
    expect(html.match(/data-error=""/g)).toHaveLength(3);
    expect(html).toContain(`id="${lineId(first)}" data-error=""`);
    expect(html).toContain("$ npm run build");
  });

  it("a clean log has no jump link; a cut one says so", () => {
    const html = renderToStaticMarkup(h(BuildLogBody, { log: { truncated: true, lines: [{ at: null, kind: "stdout", text: "Compiled successfully" }] } }));
    expect(html).not.toContain("Jump to first error");
    expect(html).toContain("No error lines");
    expect(html).toContain("the last 2,000");
  });
});
