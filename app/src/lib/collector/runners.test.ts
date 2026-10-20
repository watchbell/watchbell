import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const summary = { skipped: false, ok: true, tasks: ["rollups"], checks: 0, durationMs: 1, errors: [] };
const runCollector = vi.fn(async (t: string) => { void t; calls.push("collector"); return summary; });
const runDaily = vi.fn(async () => summary);
const runExtraSteps = vi.fn(async (s: unknown, steps: unknown) => { void steps; return s; });
const ext = vi.hoisted(() => ({ minuteSteps: [] as { name: string; run: (n: Date, c: { deadline: number }) => Promise<void> }[], dailySteps: [] as unknown[] }));

vi.mock("./run", () => ({ runCollector: (t: string) => runCollector(t) }));
vi.mock("./daily", () => ({ runDaily: () => runDaily() }));
vi.mock("./extra-steps", () => ({ runExtraSteps: (s: unknown, st: unknown) => runExtraSteps(s, st) }));
vi.mock("./core-minute-steps", () => ({ CORE_MINUTE_STEPS: [{ name: "core", run: async (_n: Date, c: { deadline: number }) => { calls.push(`core:${c.deadline}`); } }] }));
vi.mock("@/lib/extensions", () => ({ extensions: ext }));

import { runDailyAll, runMinute } from "./runners";

beforeEach(() => { calls.length = 0; ext.minuteSteps = []; ext.dailySteps = []; vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });

describe("runMinute", () => {
  it("runs the collector, then the core and extension steps in order with the 55 s deadline", async () => {
    ext.minuteSteps = [{ name: "ext", run: async (_n, c) => { calls.push(`ext:${c.deadline}`); } }];
    const out = await runMinute("builtin", 1_000_000);
    expect(runCollector).toHaveBeenCalledWith("builtin");
    expect(calls).toEqual(["collector", "core:1055000", "ext:1055000"]);
    expect(out).toBe(summary);
  });

  it("keeps going when a step throws", async () => {
    ext.minuteSteps = [
      { name: "bad", run: async () => { throw new Error("boom"); } },
      { name: "ok", run: async () => { calls.push("ok"); } },
    ];
    await expect(runMinute("cron_job_org", 0)).resolves.toBe(summary);
    expect(calls).toContain("ok");
  });
});

describe("runDailyAll", () => {
  it("passes the daily summary and the extension steps", async () => {
    const steps = [{ name: "x", run: async () => undefined }];
    ext.dailySteps = steps;
    expect(await runDailyAll()).toBe(summary);
    expect(runExtraSteps).toHaveBeenCalledWith(summary, steps);
  });
});
