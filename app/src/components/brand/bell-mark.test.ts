import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BellMark } from "@/components/brand/bell-mark";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("BellMark", () => {
  it("renders an inline svg in the navy and yellow of the favicon", () => {
    const out = html(h(BellMark));
    expect(out).toMatch(/^<svg /);
    expect(out).toContain("#14213d");
    expect(out).toContain("#fcc419");
    expect(out).not.toContain("WB");
  });
  it("is decorative by default", () => {
    const out = html(h(BellMark));
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("<title>");
    expect(out).not.toContain('role="img"');
  });
  it("is 28px unless told otherwise", () => {
    expect(html(h(BellMark))).toMatch(/width="28" height="28"/);
    expect(html(h(BellMark, { size: 40 }))).toMatch(/width="40" height="40"/);
  });
  it("names itself when given a title", () => {
    const out = html(h(BellMark, { title: "Watchbell" }));
    expect(out).toContain("<title>Watchbell</title>");
    expect(out).toContain('role="img"');
    expect(out).not.toContain("aria-hidden");
  });
  it("keeps the square visible on dark pages with an edge", () => {
    expect(html(h(BellMark))).toContain("dark:stroke-[#2f4372]");
  });
});
