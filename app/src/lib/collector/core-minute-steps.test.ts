import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ scrape: vi.fn(), guard: vi.fn(), stale: vi.fn() }));
vi.mock("@/lib/data/supabase-metrics-db", () => ({ scrapeSupabaseMetrics: h.scrape }));
vi.mock("@/lib/data/pool-guard", () => ({ guardPool: h.guard }));
vi.mock("@/lib/data/ingest-db", () => ({ resolveStaleExternal: h.stale }));
// Watchbell 1.2 (D11): the sections the owner turned off (none unless a test says so).
const sec = vi.hoisted(() => ({ paused: new Set<string>() }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => sec.paused }));

import { CORE_MINUTE_STEPS } from "./core-minute-steps";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); sec.paused = new Set(); });

describe("CORE_MINUTE_STEPS", () => {
  it("runs the Supabase compute scrape with the minute run's deadline", async () => {
    h.scrape.mockResolvedValue(null);
    expect(CORE_MINUTE_STEPS.map((s) => s.name)).toEqual(["pool-guard", "supabase-metrics", "external-stale"]);
    const now = new Date("2026-10-16T10:05:00Z");
    await CORE_MINUTE_STEPS[1].run(now, { deadline: 123_456 });
    expect(h.scrape).toHaveBeenCalledWith(now, 123_456);
  });

  it("skips the Supabase compute scrape while the Database section is off (D11)", async () => {
    sec.paused = new Set(["database"]);
    await CORE_MINUTE_STEPS[1].run(new Date(), { deadline: 1 });
    expect(h.scrape).not.toHaveBeenCalled();
    sec.paused = new Set(["hosting"]);
    await CORE_MINUTE_STEPS[1].run(new Date(), { deadline: 1 });
    expect(h.scrape).toHaveBeenCalled();
  });

  it("runs the pool guard first and never throws when it fails", async () => {
    h.guard.mockRejectedValue(new Error("pool full"));
    await expect(CORE_MINUTE_STEPS[0].run(new Date())).resolves.toBeUndefined();
    expect(h.guard).toHaveBeenCalled();
  });

  it("keeps both steps listed in selfhost, but the pool guard does nothing there", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(CORE_MINUTE_STEPS.map((s) => s.name)).toEqual(["pool-guard", "supabase-metrics", "external-stale"]);
    await CORE_MINUTE_STEPS[0].run(new Date());
    expect(h.guard).not.toHaveBeenCalled();
    h.scrape.mockResolvedValue(null);
    await CORE_MINUTE_STEPS[1].run(new Date(), { deadline: 1 });
    expect(h.scrape).toHaveBeenCalled();
  });

  // Watchbell 1.8.6: external alerts without word for 24 h (and the 5-minute test alert) resolve as stale. One cheap
  // update, at most every 5 minutes per server instance, in every edition.
  it("resolves stale external alerts at most every 5 minutes and never throws", async () => {
    const step = CORE_MINUTE_STEPS.find((s) => s.name === "external-stale")!;
    const t0 = new Date("2030-01-01T00:00:00Z");
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    h.stale.mockResolvedValue(1);
    await step.run(t0);
    await step.run(at(1));
    await step.run(at(4));
    expect(h.stale).toHaveBeenCalledTimes(1);
    await step.run(at(5));
    expect(h.stale).toHaveBeenCalledTimes(2);
    expect(h.stale).toHaveBeenLastCalledWith(at(5));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.stale.mockRejectedValue(new Error("db down"));
    await expect(step.run(at(10))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("external stale failed:", "Error");
    warn.mockRestore();
  });
});
