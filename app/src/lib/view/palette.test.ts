import { describe, expect, it } from "vitest";
import type { ClientExtension } from "@/lib/extensions";
import { buildItems, matchRank, PALETTE_MAX, type PaletteItem, rankItems, rankShown } from "./palette";

const item = (label: string, hint = "Page", href = "/x"): PaletteItem => ({ id: label + hint, label, hint, href, icon: "apps" });

describe("matchRank", () => {
  it("ranks prefix before word-start before substring, case-insensitively", () => {
    expect(matchRank("Applications", "app")).toBe(0);
    expect(matchRank("Free databases", "data")).toBe(1);
    expect(matchRank("atlas-vercel", "vercel")).toBe(1);
    expect(matchRank("orbit-blog.vercel.app", "rbit")).toBe(2);
    expect(matchRank("Overview", "ZZ")).toBeNull();
  });
  it("treats a multi-word query as one phrase", () => {
    expect(matchRank("Free databases", "free data")).toBe(0);
    expect(matchRank("Free databases", "data free")).toBeNull();
  });
});

describe("rankItems", () => {
  it("returns the first items in order for an empty or blank query", () => {
    const items = [item("b"), item("a"), item("c")];
    expect(rankItems(items, "").map((i) => i.label)).toEqual(["b", "a", "c"]);
    expect(rankItems(items, "   ").map((i) => i.label)).toEqual(["b", "a", "c"]);
  });
  it("orders prefix > word-start > substring, keeping the given order inside a rank", () => {
    const items = [item("xxdash"), item("my dash"), item("dashboard"), item("dash two"), item("other")];
    expect(rankItems(items, "dash").map((i) => i.label)).toEqual(["dashboard", "dash two", "my dash", "xxdash"]);
  });
  it("matches the hint too, after every label match", () => {
    const items = [item("Overview", "Home"), item("Home page", "Page"), item("Events", "Home")];
    expect(rankItems(items, "home").map((i) => i.label)).toEqual(["Home page", "Overview", "Events"]);
  });
  it("finds an app by its domain", () => {
    const items = [item("web", "web.example.com"), item("api", "api.example.com")];
    expect(rankItems(items, "api.ex").map((i) => i.label)).toEqual(["api"]);
  });
  it("returns no more than 20 results", () => {
    const many = Array.from({ length: 50 }, (_, i) => item(`app-${i}`));
    expect(PALETTE_MAX).toBe(20);
    expect(rankItems(many, "app")).toHaveLength(20);
    expect(rankItems(many, "")).toHaveLength(20);
  });
  it("returns an empty list when nothing matches", () => {
    expect(rankItems([item("a")], "zzz")).toEqual([]);
  });
});

describe("buildItems", () => {
  const source = {
    apps: [{ id: "a1", name: "web", domain: "web.example.com" }],
    monitors: [{ id: "m1", appId: "a1", appName: "web", path: "/api/health" }],
    domains: [{ id: "d1", name: "web.example.com" }],
  };
  it("lists watched domains after the apps, linking to the Domains page, found by the real name", () => {
    const items = buildItems("viewer", source);
    const dom = items.find((i) => i.id === "domain:d1");
    expect(dom).toMatchObject({ label: "web.example.com", hint: "Domain", href: "/domains", icon: "world" });
    expect(items.findIndex((i) => i.id === "domain:d1")).toBeGreaterThan(items.findIndex((i) => i.id === "app:a1"));
    expect(rankItems(items, "web.example.com")[0].id).toBe("domain:d1");
  });
  it("lists the pages the role can see, then apps, then monitors", () => {
    const owner = buildItems("owner", source);
    expect(owner.find((i) => i.label === "Settings")).toMatchObject({ href: "/settings", hint: "Administration" });
    expect(owner.find((i) => i.label === "web")).toMatchObject({ href: "/apps/a1", hint: "web.example.com", icon: "apps" });
    expect(owner.find((i) => i.label === "web/api/health")).toMatchObject({ href: "/apps/a1", hint: "Monitor", icon: "heartbeat" });
    expect(owner.findIndex((i) => i.label === "Overview")).toBeLessThan(owner.findIndex((i) => i.label === "web"));
  });
  it("leaves out pages a viewer cannot open", () => {
    const labels = buildItems("viewer", source).map((i) => i.label);
    expect(labels).not.toContain("Settings");
    expect(labels).not.toContain("Logs");
    expect(labels).toContain("Overview");
  });
  it("works before the apps have loaded", () => {
    expect(buildItems("operator", null).some((i) => i.href.startsWith("/apps/"))).toBe(false);
  });
  it("gives every item a unique id", () => {
    const ids = buildItems("owner", source).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  describe("extension entries (5c)", () => {
    const ext: ClientExtension = {
      nav: [{ group: "AI & API", after: "Observe", items: [
        { key: "ai", label: "AI Gateway", href: "/ai", icon: "route", stage: 5, ownerOnly: true },
        { key: "api-docs", label: "API explorer", href: "/api-docs", icon: "api", stage: 5, ownerOnly: true },
      ] }],
      palette: [{ label: "AI Gateway", href: "/ai" }, { label: "API keys", href: "/ai/keys", keywords: ["token", "wp_"] }],
    };
    it("lists the extension pages and sub-pages for owners, without duplicates", () => {
      const owner = buildItems("owner", null, ext);
      expect(owner.find((i) => i.href === "/ai")).toMatchObject({ id: "page:ai", hint: "AI & API", icon: "route" });
      expect(owner.filter((i) => i.href === "/ai")).toHaveLength(1);
      expect(owner.find((i) => i.href === "/ai/keys")).toMatchObject({ label: "API keys", hint: "AI & API · AI Gateway", icon: "route" });
      expect(rankItems(owner, "token")[0].href).toBe("/ai/keys");
    });
    it("shows none of them to operators or viewers", () => {
      for (const role of ["operator", "viewer"] as const) expect(buildItems(role, source, ext).some((i) => i.href.startsWith("/ai"))).toBe(false);
    });
  });
});

describe("rankShown (screenshot mode)", () => {
  const real = [item("Overview", "Home", "/overview"), item("orbit-blog", "web.example.com", "/apps/1"), item("portfolio", "acme.example.com", "/apps/2")];
  const shown = real.map((i) => ({ ...i, label: i.label === "orbit-blog" ? "app-a" : i.label === "portfolio" ? "app-b" : i.label, hint: i.hint.endsWith(".com") || i.hint.endsWith(".dev") ? "app-x.example" : i.hint }));
  it("finds an item by its masked or its real text, and returns what is shown", () => {
    expect(rankShown(real, shown, "app-b").map((i) => i.label)).toEqual(["app-b"]);
    expect(rankShown(real, shown, "portfolio").map((i) => i.label)).toEqual(["app-b"]);
    expect(rankShown(real, shown, "acme").map((i) => i.href)).toEqual(["/apps/2"]);
  });
  it("keeps the given order for an empty query", () => {
    expect(rankShown(real, shown, "").map((i) => i.label)).toEqual(["Overview", "app-a", "app-b"]);
  });
});
