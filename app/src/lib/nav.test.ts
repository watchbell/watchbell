import { describe, expect, it } from "vitest";
import type { ExtensionNavGroup } from "./extensions";
import { activeKey, canSee, findNav, groupOf, NAV, sectionOf, visibleNav } from "./nav";
import { SECTION_IDS, sectionsOn } from "./sections";

const keys = (role: "owner" | "operator" | "viewer") => visibleNav(role).flatMap((g) => g.items.map((i) => i.key));
const groupKeys = (role: "owner" | "operator" | "viewer" = "owner") => Object.fromEntries(visibleNav(role).map((g) => [g.group, g.items.map((i) => i.key)]));

describe("nav", () => {
  it("groups the pages into sections, in section order", () => {
    expect(visibleNav("owner").map((g) => g.group)).toEqual(["Home", "Hosting", "Database", "DevOps", "Manage"]);
    expect(NAV.map((g) => g.section)).toEqual([...SECTION_IDS]);
  });

  // Spec §5: where today's pages go. Every page is listed once.
  it("puts today's pages where spec §5 says", () => {
    expect(groupKeys()).toEqual({
      Home: ["overview", "topology", "events", "status"],
      Hosting: ["apps", "deployments", "domains", "dns", "uptime", "logs"],
      Database: ["supabase", "neon", "firebase", "turso", "upstash", "d1", "sql", "catalog"],
      DevOps: ["repos"],
      Manage: ["connections", "alerts", "sections", "settings", "backups", "status-page"],
    });
    const all = NAV.flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps every existing URL", () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    for (const href of ["/overview", "/topology", "/events", "/apps", "/deployments", "/repos", "/domains", "/dns", "/supabase", "/neon", "/firebase", "/turso",
      "/upstash", "/d1", "/sql", "/catalog", "/uptime", "/alerts", "/logs", "/status", "/connections", "/backups", "/settings"]) expect(hrefs).toContain(href);
  });

  it("puts the GitHub pages under DevOps › Automation", () => {
    expect(NAV.find((g) => g.section === "devops")?.items.map((i) => [i.key, i.sub])).toEqual([["repos", "Automation"]]);
    expect(groupOf("repos")).toBe("DevOps");
    expect(sectionOf("uptime")).toBe("hosting");
    expect(sectionOf("alerts")).toBe("manage");
  });

  it("hides the owner's pages from operators, and keeps them owner only", () => {
    for (const k of ["connections", "settings", "sections", "backups", "status-page", "sql"]) {
      expect(keys("operator")).not.toContain(k);
      expect(keys("viewer")).not.toContain(k);
      expect(keys("owner")).toContain(k);
    }
    const sections = NAV.flatMap((g) => g.items).find((i) => i.key === "sections")!;
    expect(canSee(sections, "operator")).toBe(false);
    expect(keys("operator")).toContain("logs");
    expect(keys("operator")).toContain("alerts");
    expect(groupKeys("operator").Manage).toEqual(["alerts"]);
  });

  it("also hides logs from viewers", () => {
    expect(keys("viewer")).not.toContain("logs");
  });

  it("shows only the sections that are on", () => {
    expect(visibleNav("owner", undefined, ["home", "manage"]).map((g) => g.group)).toEqual(["Home", "Manage"]);
    expect(visibleNav("owner", undefined, new Set(["home", "hosting", "manage"] as const)).map((g) => g.group)).toEqual(["Home", "Hosting", "Manage"]);
  });

  it("matches nested paths to their page", () => {
    expect(findNav("/apps/orbit-blog")?.key).toBe("apps");
    expect(activeKey("/settings")).toBe("settings");
    expect(activeKey("/manage/sections")).toBe("sections");
    expect(findNav("/manage")).toBeNull();
    expect(findNav("/nope")).toBeNull();
    expect(findNav("/applications")).toBeNull();
  });

  // Review A1, minor 8: the Status page item (a Settings tab) is highlighted on its tab.
  it("highlights Status page on its Settings tab, and Settings otherwise", () => {
    expect(activeKey("/settings", undefined, "tab=status-page")).toBe("status-page");
    expect(activeKey("/settings", undefined, new URLSearchParams("?tab=status-page"))).toBe("status-page");
    expect(activeKey("/settings?tab=status-page")).toBe("status-page");
    expect(activeKey("/settings", undefined, "tab=users")).toBe("settings");
    expect(activeKey("/settings")).toBe("settings");
    expect(activeKey("/settings/other", undefined, "tab=status-page")).toBe("settings");
  });

  // Review A1, Important 1: a fresh install (nothing connected) reaches Uptime from the menu.
  it("lists Uptime on a fresh install", () => {
    const fresh = visibleNav("owner", undefined, sectionsOn([], []));
    expect(fresh.map((g) => g.group)).toEqual(["Home", "Hosting", "Manage"]);
    expect(fresh.flatMap((g) => g.items.map((i) => i.key))).toContain("uptime");
    expect(visibleNav("operator", undefined, sectionsOn([], [])).flatMap((g) => g.items.map((i) => i.key))).toContain("uptime");
  });

  describe("extension groups (5c)", () => {
    const ext: { nav: ExtensionNavGroup[] } = { nav: [
      { section: "manage", after: "settings", items: [
        { key: "ai", label: "AI Gateway", href: "/ai", icon: "route", stage: 5, ownerOnly: true },
        { key: "api-docs", label: "API explorer", href: "/api-docs", icon: "api", stage: 5, ownerOnly: true },
      ] },
      { section: "manage", after: "alerts", items: [{ key: "auto-actions", label: "Auto-actions", href: "/auto-actions", icon: "bolt", stage: 9, ownerOnly: true }] },
    ] };

    it("puts the registry's pages into their section after their anchor, for owners only", () => {
      expect(visibleNav("owner", ext).find((g) => g.section === "manage")?.items.map((i) => i.key))
        .toEqual(["connections", "alerts", "auto-actions", "sections", "settings", "ai", "api-docs", "backups", "status-page"]);
      for (const role of ["operator", "viewer"] as const) {
        const k = visibleNav(role, ext).flatMap((g) => g.items.map((i) => i.key));
        expect(k).not.toContain("ai");
        expect(k).not.toContain("auto-actions");
      }
      // The core list is never changed in place.
      expect(NAV.find((g) => g.section === "manage")?.items.map((i) => i.key)).not.toContain("ai");
    });

    it("finds extension pages and their section", () => {
      expect(findNav("/ai/keys", ext)?.label).toBe("AI Gateway");
      expect(findNav("/ai", ext)?.key).toBe("ai");
      expect(findNav("/api-docs/status", ext)?.label).toBe("API explorer");
      expect(activeKey("/ai/quota", ext)).toBe("ai");
      expect(groupOf("api-docs", ext)).toBe("Manage");
    });

    it("has no extension page without a registry", () => {
      expect(keys("owner")).not.toContain("ai");
      expect(findNav("/ai/keys")).toBeNull();
    });

    it("appends items whose anchor is missing at the end of their section", () => {
      const lost = { nav: [{ ...ext.nav[0], after: "nope" }] };
      expect(visibleNav("owner", lost).find((g) => g.section === "manage")?.items.slice(-2).map((i) => i.key)).toEqual(["ai", "api-docs"]);
    });
  });
});
