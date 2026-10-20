import { describe, expect, it } from "vitest";
import { runOnce } from "./use-once";

describe("runOnce (Pause monitors pending guard)", () => {
  it("ignores a second pick while the first is running, and accepts one after it settles", async () => {
    const busy = { current: false };
    let finish = () => {};
    let runs = 0;
    const job = () => new Promise<void>((done) => {
      runs += 1;
      finish = done;
    });
    expect(runOnce(busy, job)).toBe(true);
    expect(runOnce(busy, job)).toBe(false);
    expect(runs).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(runOnce(busy, job)).toBe(true);
    expect(runs).toBe(2);
  });

  it("is free again after a job that fails", async () => {
    const busy = { current: false };
    runOnce(busy, () => Promise.reject(new Error("network")));
    await new Promise((r) => setTimeout(r, 0));
    expect(busy.current).toBe(false);
  });
});
