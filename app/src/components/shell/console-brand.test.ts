import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { consoleMetadata } from "@/lib/branding";
import { ConsoleBrand } from "./console-brand";

describe("the console's brand (1.7)", () => {
  it("names the brand in the sidebar header, with its logo, and keeps Personal under it", () => {
    const out = renderToStaticMarkup(h(ConsoleBrand, { name: "Studio Nusa Monitoring", hasLogo: true }));
    expect(out).toContain("Studio Nusa Monitoring");
    expect(out).toContain('src="/brand-icon"');
    expect(out).toContain("Personal");
    expect(renderToStaticMarkup(h(ConsoleBrand, { name: "Watchbell", hasLogo: false }))).toContain(">Watchbell<");
  });

  it("titles the browser tab after the brand, with its logo as the icon", () => {
    expect(consoleMetadata({ name: null, accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: false })).toEqual({});
    expect(consoleMetadata({ name: "Studio Nusa", accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: true }))
      .toEqual({ title: { default: "Studio Nusa", template: "%s · Studio Nusa" }, icons: { icon: "/brand-icon" } });
  });
});

describe("the console's brand (1.7.1, review M-9)", () => {
  it("asks for the logo's version in the sidebar", () => {
    expect(renderToStaticMarkup(h(ConsoleBrand, { name: "Studio Nusa", hasLogo: true, logoVersion: "0123456789ab" }))).toContain('src="/brand-icon?v=0123456789ab"');
  });
});
