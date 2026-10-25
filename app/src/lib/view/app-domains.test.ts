import { describe, expect, it } from "vitest";
import { appDomainLines } from "./app-domains";

const meta = (o: Record<string, unknown>) => ({ primaryDomain: "shop.example.com", domains: ["shop.example.com"], pastDomains: [] as string[], ...o });

describe("appDomainLines (Details card, Domains row)", () => {
  it("nothing stored: today's single domain, no tag", () => {
    expect(appDomainLines(null, {}, "shop.vercel.app")).toEqual({ lines: [{ name: "shop.vercel.app", tag: null, target: null }], more: 0 });
    expect(appDomainLines({ teamId: "t" }, {}, "shop.vercel.app").lines).toHaveLength(1);
  });
  it("one stored domain: a single line without a primary tag (nothing to tell it apart from)", () => {
    expect(appDomainLines(meta({}), {}, "x").lines).toEqual([{ name: "shop.example.com", tag: null, target: null }]);
  });
  it("primary first and tagged, then the other attached domains in stored order", () => {
    const m = meta({ domains: ["a.example.com", "shop.example.com", "shop.vercel.app"] });
    expect(appDomainLines(m, {}, "x").lines).toEqual([
      { name: "shop.example.com", tag: "primary", target: null },
      { name: "a.example.com", tag: null, target: null },
      { name: "shop.vercel.app", tag: null, target: null },
    ]);
  });
  it("a primary that is not in the stored list (the <name>.vercel.app fallback) is still first", () => {
    expect(appDomainLines(meta({ primaryDomain: "shop.vercel.app", domains: [] }), {}, "x").lines).toEqual([{ name: "shop.vercel.app", tag: null, target: null }]);
  });
  it("a redirect domain shows its target, an unverified one shows pending", () => {
    const m = meta({ domains: ["shop.example.com", "old.example.com", "new.example.com", "both.example.com"] });
    const flags = {
      "old.example.com": { redirect: "shop.example.com", verified: true },
      "new.example.com": { redirect: null, verified: false },
      "both.example.com": { redirect: "Shop.example.com", verified: false },
    };
    expect(appDomainLines(m, flags, "x").lines.slice(1)).toEqual([
      { name: "old.example.com", tag: "redirect", target: "shop.example.com" },
      { name: "new.example.com", tag: "pending", target: null },
      { name: "both.example.com", tag: "redirect", target: "shop.example.com" },
    ]);
  });
  it("a domain with no known flags is a plain attached one", () => {
    expect(appDomainLines(meta({ domains: ["shop.example.com", "b.example.com"] }), { "zzz": { redirect: "q", verified: false } }, "x").lines[1]).toEqual({ name: "b.example.com", tag: null, target: null });
  });
  it("the redirect target of a redirect is shown without scheme or slash", () => {
    const m = meta({ domains: ["shop.example.com", "r.example.com"] });
    expect(appDomainLines(m, { "r.example.com": { redirect: "https://shop.example.com/", verified: true } }, "x").lines[1].target).toBe("shop.example.com");
  });
  it("former domains come after, newest first, tagged former, at most 3 with +N more", () => {
    const m = meta({ pastDomains: ["p1.com", "p2.com", "p3.com", "p4.com", "p5.com"] });
    const r = appDomainLines(m, {}, "x");
    expect(r.lines.map((l) => [l.name, l.tag])).toEqual([["shop.example.com", "primary"], ["p5.com", "former"], ["p4.com", "former"], ["p3.com", "former"]]);
    expect(r.more).toBe(2);
  });
  it("a former domain that is attached again is not listed as former", () => {
    const m = meta({ domains: ["shop.example.com", "back.com"], pastDomains: ["back.com", "shop.example.com", "gone.com"] });
    expect(appDomainLines(m, {}, "x").lines.map((l) => l.name)).toEqual(["shop.example.com", "back.com", "gone.com"]);
  });
  it("primary is tagged when anything else is listed, a former domain included", () => {
    const m = meta({ pastDomains: ["old.com"] });
    expect(appDomainLines(m, {}, "x").lines[0].tag).toBe("primary");
  });
});
