import { describe, expect, it } from "vitest";
import { missingTheme, nextTheme, resolveTheme, themeInitScript } from "./theme";

describe("theme", () => {
  it("prefers a stored choice", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("falls back to the system preference", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("garbage", false)).toBe("light");
  });
  it("toggles", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });
  it("init script reads the same storage key", () => {
    expect(themeInitScript).toContain('"oc-theme"');
  });
});

describe("missingTheme (J2: the not-found page lost the dark theme)", () => {
  it("puts the stored or system theme back when React cleared <html>'s attributes", () => {
    expect(missingTheme(undefined, "dark", false)).toBe("dark");
    expect(missingTheme("", null, true)).toBe("dark");
    expect(missingTheme(undefined, null, false)).toBe("light");
  });
  it("leaves a theme that is set alone, so it never fights the toggle", () => {
    expect(missingTheme("light", "dark", true)).toBeNull();
    expect(missingTheme("dark", "light", false)).toBeNull();
  });
});
