import { describe, expect, it } from "vitest";
import { connectionGrid, drawerFromQuery, tileLine } from "./connections";

describe("Connections grid (1.2)", () => {
  it("groups the providers by the section they turn on, in sidebar order", () => {
    const g = connectionGrid([]);
    expect(g.map((x) => [x.section, x.title, x.tiles.map((t) => t.provider)])).toEqual([
      ["hosting", "Hosting", ["vercel", "cloudflare"]],
      ["database", "Database", ["supabase", "neon", "firebase", "turso", "upstash"]],
      ["devops", "DevOps", ["github", "github_write"]],
    ]);
  });

  it("marks connected providers with their account count and the ones needing attention", () => {
    const g = connectionGrid([
      { provider: "supabase", problem: null },
      { provider: "supabase", problem: "Supabase rejected this credential (401)." },
      { provider: "vercel", problem: null },
      { provider: "drive", problem: null }, // not a provider tile
    ]);
    const tiles = Object.fromEntries(g.flatMap((x) => x.tiles).map((t) => [t.provider, t]));
    expect(tiles.vercel).toEqual({ provider: "vercel", accounts: 1, attention: 0 });
    expect(tiles.supabase).toEqual({ provider: "supabase", accounts: 2, attention: 1 });
    expect(tiles.neon).toEqual({ provider: "neon", accounts: 0, attention: 0 });
    expect(tiles).not.toHaveProperty("drive");
  });

  it("words the tile's line", () => {
    expect(tileLine({ accounts: 0, attention: 0 })).toEqual({ state: "off", text: "Not connected" });
    expect(tileLine({ accounts: 1, attention: 0 })).toEqual({ state: "ok", text: "Connected" });
    expect(tileLine({ accounts: 3, attention: 0 })).toEqual({ state: "ok", text: "3 accounts connected" });
    expect(tileLine({ accounts: 1, attention: 1 })).toEqual({ state: "err", text: "Needs attention" });
    expect(tileLine({ accounts: 2, attention: 1 })).toEqual({ state: "err", text: "1 of 2 needs attention" });
    expect(tileLine({ accounts: 3, attention: 2 })).toEqual({ state: "err", text: "2 of 3 need attention" });
  });

  it("?provider= opens a known provider's drawer (or Drive's), nothing else", () => {
    expect(drawerFromQuery("neon")).toBe("neon");
    expect(drawerFromQuery(["github", "vercel"])).toBe("github");
    expect(drawerFromQuery("drive")).toBe("drive");
    expect(drawerFromQuery("jenkins")).toBeNull();
    expect(drawerFromQuery("__proto__")).toBeNull();
    expect(drawerFromQuery(undefined)).toBeNull();
  });
});
