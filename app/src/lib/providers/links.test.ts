import { describe, expect, it } from "vitest";
import { PROVIDER_INFO, PROVIDERS } from "./info";
import { PROVIDER_LINKS } from "./links";

// 1.2 (spec §7): the token links and "It needs" live in one data file, checked every release.
describe("Provider links", () => {
  it("every provider has an https create link, a non-empty needs list and a checked date", () => {
    expect(Object.keys(PROVIDER_LINKS).sort()).toEqual([...PROVIDERS].sort());
    for (const p of PROVIDERS) {
      const l = PROVIDER_LINKS[p];
      expect(new URL(l.createUrl).protocol, p).toBe("https:");
      expect(l.needs.length, p).toBeGreaterThan(0);
      expect(l.needs.every((n) => n.trim().length > 0), p).toBe(true);
      expect(l.checked, p).toBe("2026-10-21");
    }
  });

  it("PROVIDER_INFO reads them from the data file instead of keeping its own copy", () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_INFO[p].createUrl).toBe(PROVIDER_LINKS[p].createUrl);
      expect(PROVIDER_INFO[p].needs).toBe(PROVIDER_LINKS[p].needs);
      expect(PROVIDER_INFO[p].checked).toBe(PROVIDER_LINKS[p].checked);
    }
  });

  it("links straight to each dashboard's token page (the approved prototype's links)", () => {
    expect(PROVIDER_LINKS.vercel.createUrl).toBe("https://vercel.com/account/settings/tokens");
    expect(PROVIDER_LINKS.cloudflare.createUrl).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(PROVIDER_LINKS.supabase.createUrl).toBe("https://supabase.com/dashboard/account/tokens");
    expect(PROVIDER_LINKS.neon.createUrl).toBe("https://console.neon.tech/app/settings/api-keys");
    expect(PROVIDER_LINKS.github.createUrl).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(PROVIDER_LINKS.upstash.createUrl).toBe("https://console.upstash.com/account/api");
  });

  // The export's deny-list scan is private; this public check keeps a later edit from pointing a link anywhere but the
  // provider's own dashboard (an internal URL, a shortener, a lookalike domain).
  it("every create link points at the provider's own domain", () => {
    const HOSTS: Record<string, string[]> = {
      vercel: ["vercel.com"], supabase: ["supabase.com"], neon: ["console.neon.tech"], firebase: ["console.cloud.google.com"],
      turso: ["app.turso.tech"], upstash: ["console.upstash.com"], cloudflare: ["dash.cloudflare.com"],
      github: ["github.com"], github_write: ["github.com"],
    };
    for (const p of PROVIDERS) expect(HOSTS[p], p).toContain(new URL(PROVIDER_LINKS[p].createUrl).hostname);
  });

  it("no provider Watchbell supports today is a self-hosted tool, so none links to a guide yet", () => {
    expect(PROVIDERS.filter((p) => PROVIDER_LINKS[p].guide)).toEqual([]);
  });
});
