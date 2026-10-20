import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyDue, selfhostDaily, startScheduler } from "./scheduler";

describe("dailyDue", () => {
  it("is false before 03:00 WIB (19:59Z is 02:59 WIB on the 19th)", () => {
    expect(dailyDue(new Date("2026-10-18T19:59:00Z"), "2026-10-18")).toBe(false);
  });
  it("is true from 03:00 WIB on a new WIB day", () => {
    expect(dailyDue(new Date("2026-10-18T20:00:00Z"), "2026-10-18")).toBe(true);
  });
  it("is false once that WIB day has run", () => {
    expect(dailyDue(new Date("2026-10-19T01:00:00Z"), "2026-10-19")).toBe(false);
  });
  it("is true with no record once it is past 03:00 WIB", () => {
    expect(dailyDue(new Date("2026-10-19T05:00:00Z"), null)).toBe(true);
  });
});

const idle = { daily: async () => {}, readLastDay: async () => "2099-01-01" as string | null, writeLastDay: async () => {} };

describe("startScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not start a second collector run while the first is still going", async () => {
    let calls = 0;
    const minute = () => { calls++; return new Promise<void>((r) => setTimeout(r, 150_000)); };
    const s = startScheduler({ ...idle, minute });
    await vi.advanceTimersByTimeAsync(5_000);   // first tick, run starts
    await vi.advanceTimersByTimeAsync(60_000);  // 65 s: tick skipped
    await vi.advanceTimersByTimeAsync(60_000);  // 125 s: tick skipped
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);  // 185 s: the run has finished, the tick runs again
    expect(calls).toBe(2);
    s.stop();
  });

  it("runs a missed daily exactly once across several ticks and records the WIB day", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    const daily = vi.fn(async () => {});
    let stored: string | null = "2026-10-17";
    const s = startScheduler({
      minute: async () => {},
      daily,
      readLastDay: async () => stored,
      writeLastDay: async (d) => { stored = d; },
    });
    await vi.advanceTimersByTimeAsync(5_000 + 2 * 60_000); // three ticks
    expect(daily).toHaveBeenCalledTimes(1);
    expect(stored).toBe("2026-10-19");
    s.stop();
  });

  it("does not run the daily job when today's is already recorded", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    const daily = vi.fn(async () => {});
    const s = startScheduler({ ...idle, minute: async () => {}, daily, readLastDay: async () => "2026-10-19" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(daily).not.toHaveBeenCalled();
    s.stop();
  });

  it("stop() clears the interval", async () => {
    const minute = vi.fn(async () => {});
    const s = startScheduler({ ...idle, minute });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(minute).toHaveBeenCalledTimes(1);
    s.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(minute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failing collector run does not stop the schedule", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const minute = vi.fn(async () => { throw new Error("boom"); });
    const s = startScheduler({ ...idle, minute });
    await vi.advanceTimersByTimeAsync(5_000 + 60_000);
    expect(minute).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("scheduler: collector run failed: boom");
    s.stop();
    warn.mockRestore();
  });

  it("a failing daily run is logged with its cause, credentials hidden", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const daily = vi.fn(async () => { throw new Error("connect postgres://u:pw@db.example.com/x refused"); });
    const s = startScheduler({ ...idle, minute: async () => {}, daily, readLastDay: async () => null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledWith("scheduler: daily run failed, will retry on the next tick: connect postgres://[hidden]@db.example.com/x refused");
    s.stop();
    warn.mockRestore();
  });
});

describe("selfhostDaily", () => {
  it("sweeps ended sessions, then runs the shared daily job", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sweep = vi.fn(async () => 3);
    const run = vi.fn(async () => "summary");
    expect(await selfhostDaily(run, sweep)).toBe("summary");
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("scheduler: removed 3 ended sessions");
    log.mockRestore();
  });

  it("a failing sweep is logged and the daily job still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => "summary");
    expect(await selfhostDaily(run, async () => { throw new Error("db down"); })).toBe("summary");
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("scheduler: session sweep failed: db down");
    warn.mockRestore();
  });

  it("a failing daily job still fails the run, so the scheduler retries it", async () => {
    await expect(selfhostDaily(async () => { throw new Error("boom"); }, async () => 0)).rejects.toThrow("boom");
  });
});
