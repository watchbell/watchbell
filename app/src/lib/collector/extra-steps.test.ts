import { describe, expect, it, vi } from "vitest";
import { runExtraSteps } from "./extra-steps";
import type { RunSummary } from "./run";

const base: RunSummary = { skipped: false, ok: true, tasks: ["rollups"], checks: 0, durationMs: 5, errors: [] };

describe("runExtraSteps", () => {
  it("runs each step after the core ones, records a failure as a step error and keeps going", async () => {
    const now = new Date("2026-10-13T03:00:00Z");
    const a = vi.fn(async () => { throw new Error("Failed query\nBearer secret"); });
    const b = vi.fn(async () => undefined);
    const out = await runExtraSteps(base, [{ name: "ai-usage-retention", run: a }, { name: "ai-notes-retention", run: b }], now);
    expect(a).toHaveBeenCalledWith(now);
    expect(b).toHaveBeenCalledWith(now);
    expect(out.tasks).toEqual(["rollups", "ai-notes-retention"]);
    expect(out.errors).toEqual(["ai-usage-retention: Failed query"]);
    expect(out.ok).toBe(false);
  });

  it("leaves the summary alone with no steps or a skipped run", async () => {
    expect(await runExtraSteps(base, [])).toBe(base);
    const skipped = { ...base, skipped: true };
    expect(await runExtraSteps(skipped, [{ name: "x", run: async () => { throw new Error("no"); } }])).toBe(skipped);
  });
});
