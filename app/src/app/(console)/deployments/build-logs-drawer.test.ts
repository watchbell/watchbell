import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../vercel-actions", () => ({ buildLogsAction: vi.fn(), explainBuildAction: vi.fn() }));

import { DEMO_BUILD_EXPLAIN, DEMO_BUILD_LOG } from "@/lib/view/build-logs";
import { BuildLogBody, Explanation, lineId } from "./build-logs-drawer";

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

describe("Explanation (1.3 Explain with AI)", () => {
  it("shows the answer as written, the model, and a plain reminder to check it", () => {
    const html = renderToStaticMarkup(h(Explanation, { answer: DEMO_BUILD_EXPLAIN }));
    expect(html).toContain("the Cart type has no total field.");
    expect(html).toContain("File: app/checkout/page.tsx, line 12.");
    expect(html).toContain(">demo<");
    expect(html).toContain("Check it against the log");
  });

  it("asking and refused states", () => {
    expect(renderToStaticMarkup(h(Explanation, { answer: "asking" }))).toContain("Asking the AI provider");
    const err = renderToStaticMarkup(h(Explanation, { answer: { error: "Too many AI requests. Try again in 4 min." } }));
    expect(err).toContain('role="alert"');
    expect(err).toContain("Too many AI requests");
  });
});
