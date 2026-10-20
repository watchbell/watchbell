import { describe, expect, it } from "vitest";
import { providerSlug } from "./slug";

describe("providerSlug", () => {
  it("presets use their kind, a custom connection its cleaned name", () => {
    expect(providerSlug("gemini", "Google Gemini")).toBe("gemini");
    expect(providerSlug("custom", "  My Proxy (EU) ")).toBe("my-proxy-eu");
    expect(providerSlug("custom", "***")).toBe("custom");
    expect(providerSlug("custom", "a".repeat(80))).toHaveLength(40);
  });
});
