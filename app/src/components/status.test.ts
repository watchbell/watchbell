import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateIcon } from "@/components/status";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("StateIcon", () => {
  it("spins a live build", () => {
    expect(html(h(StateIcon, { state: "build" }))).toContain("animate-spin");
  });
  it("draws a still build icon for history rows (an old 'Deployment started' event must not spin forever)", () => {
    const out = html(h(StateIcon, { state: "build", still: true }));
    expect(out).not.toContain("animate-spin");
    expect(out).toContain("<svg");
  });
  it("uses a different glyph for a still build than the spinner", () => {
    expect(html(h(StateIcon, { state: "build", still: true }))).not.toBe(html(h(StateIcon, { state: "build" })));
  });
  it("leaves other states alone when still", () => {
    expect(html(h(StateIcon, { state: "ok", still: true }))).toBe(html(h(StateIcon, { state: "ok" })));
  });
});
