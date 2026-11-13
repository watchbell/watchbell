import { describe, expect, it } from "vitest";
import { COST_RANK, HOSTING_CHECKED_ON, HOSTING_SOURCES, HOSTS, type LangId, LANGS } from "./hosting";

const ALL: LangId[] = ["nextjs", "static", "node", "python", "php", "go", "java", "dotnet", "ruby", "docker"];

describe("hosting data (Deploy an app)", () => {
  it("has a tile for every language, once each, with a verdict and at least one host", () => {
    expect(LANGS.map((l) => l.id).sort()).toEqual([...ALL].sort());
    for (const l of LANGS) {
      expect(l.note.length, l.id).toBeGreaterThan(20);
      expect(l.hosts.length, l.id).toBeGreaterThan(0);
      expect(new Set(l.hosts.map((h) => h.host)).size, l.id).toBe(l.hosts.length);
    }
  });
  it("names only hosts it describes, each with a one-line catch", () => {
    for (const l of LANGS) for (const h of l.hosts) {
      expect(HOSTS[h.host], `${l.id} → ${h.host}`).toBeDefined();
      expect(h.catch, `${l.id} → ${h.host}`).toMatch(/^\S.{4,110}$/);
    }
  });
  it("lists free first, then free with a card, trial, paid, and guide-only last", () => {
    for (const l of LANGS) {
      const ranks = l.hosts.map((h) => COST_RANK[HOSTS[h.host].cost]);
      expect(ranks, l.id).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
  it("links only to official https pages; guides have steps that end with Uptime", () => {
    for (const h of Object.values(HOSTS)) {
      expect(h.newUrl, h.id).toMatch(/^https:\/\//);
      expect(h.source, h.id).toMatch(/^https:\/\//);
      if (h.cost === "guide") {
        expect(h.guide?.length ?? 0, h.id).toBeGreaterThanOrEqual(3);
        expect(h.guide?.at(-1), h.id).toMatch(/Uptime/);
      } else expect(h.guide, h.id).toBeUndefined();
    }
  });
  it("only Vercel is a host Watchbell syncs (Cloudflare apps aren't synced as applications, review I1)", () => {
    const synced = Object.values(HOSTS).filter((h) => h.provider).map((h) => `${h.id}:${h.provider}`).sort();
    expect(synced).toEqual(["vercel:vercel"]);
  });
  it("says nothing the 12 Nov re-check doesn't (review M2)", () => {
    const all = JSON.stringify({ HOSTS, LANGS });
    expect(all).not.toMatch(/deleted after 30 days|no database on new accounts|; comfortable for Spring Boot/);
    expect(HOSTS.railway.price).toBe("$5 trial, then $1 credit or $5/mo");
    expect(LANGS.find((l) => l.id === "nextjs")?.hosts.find((h) => h.host === "cloudflare")?.catch).toMatch(/10 ms CPU/);
  });
  it("is dated, and names its sources", () => {
    expect(HOSTING_CHECKED_ON).toMatch(/^\d{1,2} [A-Z][a-z]{2} 20\d\d$/);
    expect(HOSTING_SOURCES.length).toBeGreaterThan(5);
    for (const [, url] of HOSTING_SOURCES) expect(url).toMatch(/^https:\/\//);
  });
});
