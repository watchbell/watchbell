import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ scrape: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/data/supabase-metrics-db", () => ({ scrapeSupabaseMetrics: h.scrape }));
vi.mock("@/lib/data/pool-guard", () => ({ guardPool: h.guard }));
// Watchbell 1.2 (D11): the sections the owner turned off (none unless a test says so).
const sec = vi.hoisted(() => ({ paused: new Set<string>() }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => sec.paused }));

import { CORE_MINUTE_STEPS } from "./core-minute-steps";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); sec.paused = new Set(); });

describe("CORE_MINUTE_STEPS", () => {
  it("runs the Supabase compute scrape with the minute run's deadline", async () => {
    h.scrape.mockResolvedValue(null);
    expect(CORE_MINUTE_STEPS.map((s) => s.name)).toEqual(["pool-guard", "supabase-metrics"]);
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
    expect(CORE_MINUTE_STEPS.map((s) => s.name)).toEqual(["pool-guard", "supabase-metrics"]);
    await CORE_MINUTE_STEPS[0].run(new Date());
    expect(h.guard).not.toHaveBeenCalled();
    h.scrape.mockResolvedValue(null);
    await CORE_MINUTE_STEPS[1].run(new Date(), { deadline: 1 });
    expect(h.scrape).toHaveBeenCalled();
  });
});
