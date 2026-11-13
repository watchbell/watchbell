import { describe, expect, it } from "vitest";
import { cvssText, nvdUrl } from "./links";

describe("vulnerability links and score text", () => {
  it("links a CVE to NVD, and nothing else", () => {
    expect(nvdUrl("CVE-2025-29927")).toBe("https://nvd.nist.gov/vuln/detail/CVE-2025-29927");
    expect(nvdUrl("GHSA-f82v-jwr5-mffw")).toBeNull();
    expect(nvdUrl("CVE-2025-1/../x")).toBeNull();
  });
  it("shows a score with one decimal, none when missing", () => {
    expect(cvssText(9.8)).toBe("9.8");
    expect(cvssText(7)).toBe("7.0");
    expect(cvssText(null)).toBeNull();
    expect(cvssText(undefined)).toBeNull();
  });
});
