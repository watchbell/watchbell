import { describe, expect, it } from "vitest";
import type { ExtensionNavGroup } from "./extensions";
import { activeKey, findNav, groupOf, visibleNav } from "./nav";

const keys = (role: "owner" | "operator" | "viewer") => visibleNav(role).flatMap((g) => g.items.map((i) => i.key));

describe("nav", () => {
  it("shows everything to owners, in mockup order", () => {
    expect(visibleNav("owner").map((g) => g.group)).toEqual(["Home", "Workloads", "GitHub", "Network", "Databases", "Observe", "Administration"]);
    expect(keys("owner")).toContain("connections");
  });

  it("hides administration from operators", () => {
    expect(keys("operator")).not.toContain("connections");
    expect(keys("operator")).not.toContain("settings");
    expect(keys("operator")).toContain("logs");
    expect(visibleNav("operator").map((g) => g.group)).not.toContain("Administration");
  });

  it("also hides logs from viewers", () => {
    expect(keys("viewer")).not.toContain("logs");
  });

  it("matches nested paths to their section", () => {
    expect(findNav("/apps/orbit-blog")?.key).toBe("apps");
    expect(activeKey("/settings")).toBe("settings");
    expect(findNav("/nope")).toBeNull();
  });

  describe("extension groups (5c)", () => {
    const ext: { nav: ExtensionNavGroup[] } = { nav: [{ group: "AI & API", after: "Observe", items: [
      { key: "ai", label: "AI Gateway", href: "/ai", icon: "route", stage: 5, ownerOnly: true },
      { key: "api-docs", label: "API explorer", href: "/api-docs", icon: "api", stage: 5, ownerOnly: true },
    ] }] };

    it("puts the registry's group after its anchor, for owners only", () => {
      expect(visibleNav("owner", ext).map((g) => g.group)).toEqual(["Home", "Workloads", "GitHub", "Network", "Databases", "Observe", "AI & API", "Administration"]);
      expect(visibleNav("operator", ext).map((g) => g.group)).not.toContain("AI & API");
      expect(visibleNav("viewer", ext).map((g) => g.group)).not.toContain("AI & API");
    });

    it("finds extension pages and their group", () => {
      expect(findNav("/ai/keys", ext)?.label).toBe("AI Gateway");
      expect(findNav("/ai", ext)?.key).toBe("ai");
      expect(findNav("/api-docs/status", ext)?.label).toBe("API explorer");
      expect(activeKey("/ai/quota", ext)).toBe("ai");
      expect(groupOf("api-docs", ext)).toBe("AI & API");
    });

    it("has no extension group without a registry", () => {
      expect(visibleNav("owner").map((g) => g.group)).not.toContain("AI & API");
      expect(findNav("/ai/keys")).toBeNull();
    });

    it("appends a group whose anchor is missing", () => {
      const lost = { nav: [{ ...ext.nav[0], after: "Nope" }] };
      expect(visibleNav("owner", lost).at(-1)?.group).toBe("AI & API");
    });
  });
});
