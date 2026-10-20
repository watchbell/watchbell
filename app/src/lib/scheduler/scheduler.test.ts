import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock, dayKey, resetTimeZoneForTests } from "@/lib/time";
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

// Every minute from `from` to `to`, remembering the last day like startScheduler does: when and on which day it ran.
function simulate(due: (now: Date, last: string | null) => boolean, from: string, to: string): { day: string; at: string }[] {
  const runs: { day: string; at: string }[] = [];
  let last: string | null = null;
  for (let t = Date.parse(from); t < Date.parse(to); t += 60_000) {
    const now = new Date(t);
    if (!due(now, last)) continue;
    last = dayKey(now);
    runs.push({ day: last, at: clock(now) });
  }
  return runs;
}

describe("dailyDue in a zone with daylight saving (1.1)", () => {
  afterEach(() => resetTimeZoneForTests());

  it("Europe/Berlin: once a local day at 03:00, also on 29 Mar (23 h) and 25 Oct (25 h)", () => {
    resetTimeZoneForTests("Europe/Berlin");
    const spring = simulate(dailyDue, "2026-03-27T23:00:00Z", "2026-03-31T22:00:00Z");
    expect(spring).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"].map((day) => ({ day, at: "03:00" })));
    const autumn = simulate(dailyDue, "2026-10-23T22:00:00Z", "2026-10-27T23:00:00Z");
    expect(autumn).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"].map((day) => ({ day, at: "03:00" })));
    expect(dailyDue(new Date("2026-03-29T00:59:00Z"), "2026-03-28")).toBe(false); // 01:59 CET
    expect(dailyDue(new Date("2026-03-29T01:00:00Z"), "2026-03-28")).toBe(true); // 03:00 CEST, an hour later
    expect(dailyDue(new Date("2026-10-25T01:59:00Z"), "2026-10-24")).toBe(false); // 02:59 CET, the second time round
    expect(dailyDue(new Date("2026-10-25T02:00:00Z"), "2026-10-24")).toBe(true); // 03:00 CET
  });

  it("America/New_York: once a local day at 03:00 around 8 Mar and 1 Nov", () => {
    resetTimeZoneForTests("America/New_York");
    expect(simulate(dailyDue, "2026-03-07T05:00:00Z", "2026-03-10T04:00:00Z")).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"].map((day) => ({ day, at: "03:00" })));
    expect(simulate(dailyDue, "2026-10-31T04:00:00Z", "2026-11-03T05:00:00Z")).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"].map((day) => ({ day, at: "03:00" })));
  });

  it("Asia/Kathmandu: 03:00 is 21:15 UTC", () => {
    resetTimeZoneForTests("Asia/Kathmandu");
    expect(dailyDue(new Date("2026-10-18T21:14:00Z"), "2026-10-18")).toBe(false);
    expect(dailyDue(new Date("2026-10-18T21:15:00Z"), "2026-10-18")).toBe(true);
  });

  it("after the zone moves back a day (WIB → America/Los_Angeles) it doesn't run again", () => {
    resetTimeZoneForTests("America/Los_Angeles");
    // Ran at 03:00 WIB on 19 Oct (stored "2026-10-19"); at 20:00Z it is 13:00 on 18 Oct in Los Angeles.
    expect(dailyDue(new Date("2026-10-18T20:00:00Z"), "2026-10-19")).toBe(false);
    expect(dailyDue(new Date("2026-10-19T10:00:00Z"), "2026-10-19")).toBe(false); // 03:00 on the 19th there: done already
    expect(dailyDue(new Date("2026-10-20T10:00:00Z"), "2026-10-19")).toBe(true);
  });

  it("recovers from a stored day more than one day ahead (a clock that was once wrong); tomorrow is still trusted", () => {
    resetTimeZoneForTests();
    const now = new Date("2026-10-19T05:00:00Z"); // 12:00 WIB on the 19th
    expect(dailyDue(now, "2027-03-01")).toBe(true);
    expect(dailyDue(now, "2026-10-21")).toBe(true);
    expect(dailyDue(now, "2026-10-20")).toBe(false); // a change of zone can put it one day ahead
    expect(dailyDue(now, "2026-10-19")).toBe(false);
    expect(dailyDue(now, "not a day")).toBe(true);
    expect(dailyDue(new Date("2026-10-18T19:59:00Z"), "2027-03-01")).toBe(false); // 02:59 WIB: not 03:00 yet
    resetTimeZoneForTests("America/Los_Angeles");
    expect(dailyDue(new Date("2026-10-18T20:00:00Z"), "2026-10-20")).toBe(true); // 13:00 on the 18th there
    expect(dailyDue(new Date("2026-10-18T20:00:00Z"), "2026-10-19")).toBe(false);
  });

  it("a stored day from a wrong clock runs the missed job once, then keeps today's", () => {
    resetTimeZoneForTests();
    let last: string | null = "2027-03-01";
    const runs: string[] = [];
    for (let t = Date.parse("2026-10-19T00:00:00Z"); t < Date.parse("2026-10-21T00:00:00Z"); t += 60_000) {
      const now = new Date(t);
      if (!dailyDue(now, last)) continue;
      last = dayKey(now);
      runs.push(`${last} ${clock(now)}`);
    }
    // Until 07:00 WIB on the 21st: the missed run at once (07:00 on the 19th), then 03:00 every day.
    expect(runs).toEqual(["2026-10-19 07:00", "2026-10-20 03:00", "2026-10-21 03:00"]);
  });

  it("the default zone still runs at 03:00 WIB", () => {
    resetTimeZoneForTests();
    expect(simulate(dailyDue, "2026-10-17T17:00:00Z", "2026-10-19T17:00:00Z")).toEqual([{ day: "2026-10-18", at: "03:00" }, { day: "2026-10-19", at: "03:00" }]);
  });
});

// Today (in the configured zone) is already done, so the daily job stays idle. Not a far-future day: a stored day more
// than one day ahead is not trusted (a clock that was once wrong), and the job would run.
const idle = { daily: async () => {}, readLastDay: async () => dayKey(new Date()) as string | null, writeLastDay: async () => {} };

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
