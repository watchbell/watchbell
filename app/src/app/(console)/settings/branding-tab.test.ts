import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./branding-actions", () => ({ saveBranding: vi.fn(), removeBrandLogo: vi.fn() }));

import { DEFAULT_BRAND } from "@/lib/branding";
import { BrandingTab } from "./branding-tab";

describe("BrandingTab (1.7)", () => {
  it("has every field, explains what stays Watchbell, and shows the saved values", () => {
    const out = renderToStaticMarkup(h(BrandingTab, { brand: { ...DEFAULT_BRAND, name: "Studio Nusa Monitoring", accent: "#0f766e", hasLogo: true } }));
    for (const label of ["App name", "Logo", "Accent colour", "Email sender name", "Public address", "Powered by Watchbell"]) expect(out).toContain(label);
    expect(out).toContain('value="Studio Nusa Monitoring"');
    expect(out).toContain("#0f766e");
    expect(out).toContain("/brand-icon");
    expect(out).toContain("Remove logo");
    expect(out).toMatch(/address stays the one your mail channel uses/);
  });

  it("shows no logo preview without a logo", () => {
    const out = renderToStaticMarkup(h(BrandingTab, { brand: DEFAULT_BRAND }));
    expect(out).not.toContain("/brand-icon");
    expect(out).not.toContain("Remove logo");
  });
});

describe("BrandingTab logo preview (1.7.1, review M-9)", () => {
  it("asks for the logo's version", () => {
    expect(renderToStaticMarkup(h(BrandingTab, { brand: { ...DEFAULT_BRAND, hasLogo: true, logoVersion: "0123456789ab" } }))).toContain('src="/brand-icon?v=0123456789ab"');
  });
});
