import { describe, expect, it } from "vitest";
import { CATALOG_SOURCES, canMonitor, CHECKED_ON, FIRST_CHECKED_ON, FREE_DBS, NOT_FREE, PICKS } from "./free-databases";

describe("free databases catalog (spec §5, mockup catalog())", () => {
  it("says when it was checked, with an official https page for every re-checked plan (stage 8)", () => {
    expect(CHECKED_ON).toBe("16 Oct 2026");
    expect(FIRST_CHECKED_ON).toBe("11 Oct 2026");
    expect(CATALOG_SOURCES.map(([n]) => n)).toEqual([
      "Vercel Hobby", "Vercel Web Analytics", "Supabase Free", "Neon Free", "Firebase Spark (Firestore)", "Cloudflare D1",
      "Cloudflare Workers", "Upstash Redis", "Upstash QStash", "Turso", "cron-job.org",
    ]);
    for (const [, url] of CATALOG_SOURCES) expect(new URL(url).protocol).toBe("https:");
    // Rows outside the stage 8 re-check say they are older.
    expect(FREE_DBS.filter((d) => d.checked).map((d) => d.name)).toEqual(["TiDB Cloud Starter", "MongoDB Atlas", "Prisma Postgres", "Convex", "Aiven", "Nile"]);
  });
  it("carries the numbers read on 16 Oct 2026", () => {
    const by = (n: string) => FREE_DBS.find((d) => d.name === n)!.limits;
    expect(by("Supabase")).toContain("5 GB egress + 5 GB cached egress");
    expect(by("Neon")).toContain("5 GB egress per project a month");
    expect(by("Turso")).toContain("500M rows read and 10M rows written a month");
    expect(by("Upstash Redis")).toContain("500k commands a month");
    expect(by("Cloudflare D1")).toContain("5 GB per account");
  });
  it("lists every provider once with an https pricing page", () => {
    expect(new Set(FREE_DBS.map((d) => d.name)).size).toBe(FREE_DBS.length);
    for (const d of FREE_DBS) {
      expect(new URL(d.url).protocol, d.name).toBe("https:");
      for (const v of [d.type, d.limits, d.sleep, d.monitor, d.pick]) expect(v.trim().length, d.name).toBeGreaterThan(0);
    }
  });
  it("marks the six providers the console monitors as built, Turso, Upstash and D1 included (spec §18 stage 8)", () => {
    expect(FREE_DBS.filter((d) => d.adapter === "built").map((d) => d.name)).toEqual(["Supabase", "Neon", "Firebase Firestore", "Turso", "Upstash Redis", "Cloudflare D1"]);
    expect(FREE_DBS.filter((d) => d.adapter === "planned")).toEqual([]);
    expect(FREE_DBS.filter(canMonitor)).toHaveLength(6);
  });
  it("names only providers it lists in the picks, and keeps the not-free list apart", () => {
    const names = FREE_DBS.map((d) => d.name.replace("Firebase ", ""));
    for (const [, best] of PICKS) expect(names).toContain(best);
    for (const [name] of NOT_FREE) expect(FREE_DBS.some((d) => d.name === name)).toBe(false);
  });
});
