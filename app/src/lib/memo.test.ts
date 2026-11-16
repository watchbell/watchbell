import { describe, expect, it, vi } from "vitest";
import { ttlMemo } from "./memo";

// 1.8.1 (public routes audit): a public page that reads the database on every request can be flooded until the
// pooler's 15 slots are gone. ttlMemo keeps the last answer per server instance for a short time, and concurrent
// callers share one read.
describe("ttlMemo", () => {
  it("reads once within the time, again after it", async () => {
    let now = 1_000;
    const fn = vi.fn(async () => "v");
    const m = ttlMemo(fn, 60_000, () => now);
    await m.get(); await m.get();
    expect(fn).toHaveBeenCalledTimes(1);
    now += 60_001;
    await m.get();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent callers", async () => {
    const fn = vi.fn(async () => 1);
    const m = ttlMemo(fn, 60_000);
    await Promise.all([m.get(), m.get(), m.get()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("forgets on clear, and does not keep a failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue("ok");
    const m = ttlMemo(fn as () => Promise<string>, 60_000);
    await expect(m.get()).rejects.toThrow("down");
    await expect(m.get()).resolves.toBe("ok");
    m.clear();
    await m.get();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// Final review I2: in the demo each visitor has a database of their own (picked from their cookie), so a process-wide
// memo would show one visitor's logo or status page to another. The memo is skipped there.
describe("ttlMemo when skipped", () => {
  it("reads every time while skip() is true", async () => {
    const fn = vi.fn(async () => "v");
    const m = ttlMemo(fn, 60_000, Date.now, () => true);
    await m.get(); await m.get();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
