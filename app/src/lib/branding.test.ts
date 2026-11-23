import { describe, expect, it } from "vitest";
import { png } from "./png-fixture";
import { brandIconPath, brandProblems, brandStyle, consoleMetadata, logoFileProblem, contrastRatio, DEFAULT_BRAND, displayName, logoProblem, parseBrand, parseBrandForm, senderFrom } from "./branding";
import { logoVersionOf } from "./branding-version";

const studio = { name: "Studio Nusa Monitoring", accent: "#0f766e", senderName: "Studio Nusa", publicUrl: "https://monitor.studionusa.id", poweredBy: true, hasLogo: true };

describe("branding (1.7)", () => {
  it("measures contrast like WCAG", () => {
    expect(contrastRatio("#0f766e", "#ffffff")).toBeCloseTo(5.47, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("accepts a readable brand and names what fails", () => {
    expect(brandProblems(studio)).toEqual({});
    expect(brandProblems({ ...studio, accent: "#fde047" }).accent).toMatch(/light background/);
    expect(brandProblems({ ...studio, accent: "#1f2937" }).accent).toMatch(/dark background/);
    expect(brandProblems({ ...studio, accent: "teal" }).accent).toMatch(/#rrggbb/);
    expect(brandProblems({ ...studio, senderName: "A<b" }).senderName).toBeDefined();
    expect(brandProblems({ ...studio, senderName: "x\r\nBcc: y" }).senderName).toBeDefined();
    expect(brandProblems({ ...studio, publicUrl: "http://x.com" }).publicUrl).toBeDefined();
    expect(brandProblems({ ...studio, publicUrl: "http://localhost:3100" })).toEqual({});
    expect(brandProblems({ ...studio, name: "x".repeat(61) }).name).toBeDefined();
  });

  // 1.8.4 (owner's test on ops, 22 Nov): "https://ops.example.com/s/monitorings" was saved, so every email link would have
  // been …/s/monitorings/alerts (404). Watchbell always runs at the root of its address: only the address itself.
  it("takes only the console's address, without a path, query or #", () => {
    for (const bad of ["https://ops.example.com/s/monitorings", "https://ops.example.com/alerts", "https://ops.example.com/?x=1", "https://ops.example.com/#top"]) {
      expect(brandProblems({ ...studio, publicUrl: bad }).publicUrl).toMatch(/no path/);
    }
    expect(brandProblems({ ...studio, publicUrl: "https://ops.example.com" })).toEqual({});
    expect(brandProblems({ ...studio, publicUrl: "https://ops.example.com/" })).toEqual({});
    expect(brandProblems({ ...studio, publicUrl: "https://ops.example.com:8443" })).toEqual({});
  });

  // Final review 1.8.4 M4: an empty ? or #, a user:password@ and a line break inside the host all passed the URL check,
  // and the raw text is what the email links are built on. The form keeps the address's origin; a stored value must be one.
  it("keeps only the origin: an empty ? or #, credentials and line breaks never reach the links", () => {
    for (const bad of ["https://ops.example.com?", "https://ops.example.com#", "https://user:pw@ops.example.com", "https://ops.example\n.com"]) {
      expect(brandProblems({ ...studio, publicUrl: bad }).publicUrl).toBeDefined();
    }
    const form = (publicUrl: string) => parseBrandForm({ name: "", accent: "", senderName: "", publicUrl, poweredBy: "on" });
    expect(form("https://OPS.example.com:443/")).toMatchObject({ ok: true, value: { publicUrl: "https://ops.example.com" } });
    expect(form("https://ops.example.com?")).toMatchObject({ ok: true, value: { publicUrl: "https://ops.example.com" } });
    expect(form("https://user:pw@ops.example.com")).toMatchObject({ ok: false });
    expect(form("https://ops.example.com/s/monitorings")).toMatchObject({ ok: false });
  });

  it("a stored address with a path (saved before 1.8.4) is read as blank, so links use the address Watchbell runs at", () => {
    expect(parseBrand({ ...studio, publicUrl: "https://ops.example.com/s/monitorings" }).publicUrl).toBeNull();
    expect(parseBrand({ ...studio, publicUrl: "https://ops.example.com" }).publicUrl).toBe("https://ops.example.com");
  });

  it("takes a square PNG up to 512 px and 256 KB, nothing else", () => {
    expect(logoProblem(png(256, 256))).toBeNull();
    expect(logoProblem(png(256, 240))).toBeNull(); // within 10%
    expect(logoProblem(png(600, 300))).toMatch(/square/);
    expect(logoProblem(png(1024, 1024))).toMatch(/512/);
    expect(logoProblem(png(256, 256, 300 * 1024))).toMatch(/256 KB/);
    expect(logoProblem(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toMatch(/PNG/);
  });

  it("falls back to Watchbell, and only changes the sender's display name", () => {
    expect(displayName(DEFAULT_BRAND)).toBe("Watchbell");
    expect(displayName(studio)).toBe("Studio Nusa Monitoring");
    expect(DEFAULT_BRAND.poweredBy).toBe(true);
    expect(senderFrom(studio, "alerts@example.com")).toBe('"Studio Nusa" <alerts@example.com>');
    expect(senderFrom(DEFAULT_BRAND, "alerts@example.com")).toBe("Watchbell <alerts@example.com>");
  });

  it("reads the settings form leniently: blank fields mean the default", () => {
    expect(parseBrandForm({ name: "  ", accent: "", senderName: "", publicUrl: "", poweredBy: "on" })).toEqual({ ok: true, value: { ...DEFAULT_BRAND } });
    const r = parseBrandForm({ name: "Studio Nusa Monitoring", accent: "#0F766E", senderName: "Studio Nusa", publicUrl: "https://monitor.studionusa.id/", poweredBy: undefined });
    expect(r).toEqual({ ok: true, value: { name: "Studio Nusa Monitoring", accent: "#0f766e", senderName: "Studio Nusa", publicUrl: "https://monitor.studionusa.id", poweredBy: false, hasLogo: false, logoVersion: null } });
    expect(parseBrandForm({ accent: "#fde047" })).toMatchObject({ ok: false, fieldErrors: { accent: expect.any(String) } });
  });
});

describe("brandStyle (1.7)", () => {
  it("is nothing without an accent, and sets the brand colour for light and dark otherwise", () => {
    expect(brandStyle(DEFAULT_BRAND)).toBeNull();
    const css = brandStyle({ ...DEFAULT_BRAND, accent: "#0f766e" })!;
    expect(css).toContain(':root:root, :root:root[data-theme="dark"]');
    expect(css).toContain("--oc-brand: #0f766e");
    expect(css).toContain("--oc-on-brand: #ffffff");
    expect(brandStyle({ ...DEFAULT_BRAND, accent: "red;}body{x" })).toBeNull();
  });
});

// Review I-7: a big file never reaches the server action (Next refuses bodies over 1 MB before it runs), so the
// browser checks the file first and says why.
describe("logoFileProblem (1.7)", () => {
  it("refuses a non-PNG or a file over 256 KB before upload, and lets a small PNG through", () => {
    expect(logoFileProblem({ size: 5 * 1024 * 1024, type: "image/png" })).toBe("The logo must be 256 KB or smaller.");
    expect(logoFileProblem({ size: 10_000, type: "image/jpeg" })).toBe("The logo must be a PNG file.");
    expect(logoFileProblem({ size: 10_000, type: "image/png" })).toBeNull();
    expect(logoFileProblem({ size: 0, type: "" })).toBeNull(); // no file chosen
  });
});

// Review M-9 (1.7.1): the icon's address carries the logo's version, so the CDN can keep it and a new logo shows at once.
describe("brand icon version (1.7.1)", () => {
  it("is the first 12 hex characters of the PNG's SHA-256", () => {
    expect(logoVersionOf(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01");
  });
  it("puts the version in the icon's address", () => {
    expect(brandIconPath("0123456789ab")).toBe("/brand-icon?v=0123456789ab");
    expect(brandIconPath(null)).toBe("/brand-icon");
    expect(consoleMetadata({ ...DEFAULT_BRAND, name: "Studio Nusa", hasLogo: true, logoVersion: "0123456789ab" }).icons).toEqual({ icon: "/brand-icon?v=0123456789ab" });
  });
  it("keeps only a well-formed version from the stored row", () => {
    expect(parseBrand({ hasLogo: true, logoVersion: "0123456789ab" }).logoVersion).toBe("0123456789ab");
    expect(parseBrand({ hasLogo: true, logoVersion: "../x" }).logoVersion).toBeNull();
    expect(parseBrandForm({ name: "A" }).ok && DEFAULT_BRAND.logoVersion).toBeNull();
  });
});
