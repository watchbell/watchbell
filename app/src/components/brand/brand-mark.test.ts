import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark (1.7)", () => {
  it("is the brand's logo when there is one, else the Watchbell bell", () => {
    expect(renderToStaticMarkup(h(BrandMark, { name: "Studio Nusa", hasLogo: true }))).toContain('<img src="/brand-icon" alt="Studio Nusa"');
    const bell = renderToStaticMarkup(h(BrandMark, { name: "Watchbell", hasLogo: false }));
    expect(bell).toContain("<svg");
    expect(bell).not.toContain("/brand-icon");
  });
});

describe("BrandMark (1.7.1)", () => {
  it("asks for the logo's version, so the CDN copy is the current one", () => {
    expect(renderToStaticMarkup(h(BrandMark, { name: "Studio Nusa", hasLogo: true, logoVersion: "0123456789ab" }))).toContain('<img src="/brand-icon?v=0123456789ab"');
  });
});
