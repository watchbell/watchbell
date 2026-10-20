import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";
import { parseInline, parseMarkdown } from "./markdown-parse";

const html = (src: string) => renderToStaticMarkup(h(Markdown, { source: src }));

describe("parseMarkdown", () => {
  it("builds paragraphs, headings, lists and code blocks", () => {
    expect(parseMarkdown("# Title\n\nOne line\nsecond line\n\n- a\n- b\n\n1. x\n2. y\n\n```\ncode here\n```")).toEqual([
      { t: "h", inl: [{ t: "text", text: "Title" }] },
      { t: "p", inl: [{ t: "text", text: "One line second line" }] },
      { t: "ul", items: [[{ t: "text", text: "a" }], [{ t: "text", text: "b" }]] },
      { t: "ol", items: [[{ t: "text", text: "x" }], [{ t: "text", text: "y" }]] },
      { t: "code", text: "code here" },
    ]);
  });
  it("handles bold, inline code and links as text", () => {
    expect(parseInline("a **b** `c` [d](https://e.example.com/x) [f](javascript:void)")).toEqual([
      { t: "text", text: "a " }, { t: "b", text: "b" }, { t: "text", text: " " }, { t: "code", text: "c" }, { t: "text", text: " " },
      { t: "text", text: "d (https://e.example.com/x)" }, { t: "text", text: " " }, { t: "text", text: "f" },
    ]);
  });
  it("cuts the source at 8,000 characters", () => {
    const [b] = parseMarkdown("x".repeat(20_000));
    expect(b.t === "p" && b.inl[0].text.length).toBe(8000);
  });
});

describe("Markdown render (no raw HTML, no links)", () => {
  it("escapes raw html and scripts", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="alert(2)"> **ok**');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<b ");
  });
  it("never renders an anchor, even for a markdown link", () => {
    const out = html("[click](https://evil.example.com) and [x](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href");
    expect(out).toContain("click (https://evil.example.com)");
  });
  it("renders lists and code", () => {
    const out = html("- one\n- two\n\n```\nrm -rf /\n```");
    expect(out).toContain("<ul");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<pre");
  });
});
