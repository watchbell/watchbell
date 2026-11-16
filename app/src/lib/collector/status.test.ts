import { describe, expect, it } from "vitest";
import { collectorHealth, cronJobRow, schedulerRun } from "./status";

const now = new Date("2026-10-12T10:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("collectorHealth", () => {
  it("matches the mockup when healthy and turns amber, then red, as runs stop", () => {
    expect(collectorHealth(ago(12), now)).toEqual({ state: "ok", text: "Collector ran 12s ago" });
    expect(collectorHealth(ago(90), now)).toEqual({ state: "ok", text: "Collector ran 1 min ago" });
    expect(collectorHealth(ago(200), now)).toEqual({ state: "warn", text: "Collector late · ran 3 min ago" });
    expect(collectorHealth(ago(900), now)).toEqual({ state: "err", text: "Collector stopped 15 min ago" });
    expect(collectorHealth(null, now)).toEqual({ state: "idle", text: "Collector hasn't run yet" });
  });

  it("switches at 60 s, 120 s and 300 s", () => {
    expect(collectorHealth(ago(59), now)).toEqual({ state: "ok", text: "Collector ran 59s ago" });
    expect(collectorHealth(ago(60), now)).toEqual({ state: "ok", text: "Collector ran 1 min ago" });
    expect(collectorHealth(ago(119), now)).toEqual({ state: "ok", text: "Collector ran 1 min ago" });
    expect(collectorHealth(ago(120), now)).toEqual({ state: "warn", text: "Collector late · ran 2 min ago" });
    expect(collectorHealth(ago(299), now)).toEqual({ state: "warn", text: "Collector late · ran 4 min ago" });
    expect(collectorHealth(ago(300), now)).toEqual({ state: "err", text: "Collector stopped 5 min ago" });
  });

  it("follows a longer CollectorStale limit: a 30-minute schedule with the rule at 40 minutes stays ok between runs", () => {
    const limit = 40 * 60_000;
    expect(collectorHealth(ago(25 * 60), now, limit)).toEqual({ state: "ok", text: "Collector ran 25 min ago" });
    expect(collectorHealth(ago(31 * 60), now, limit)).toEqual({ state: "ok", text: "Collector ran 31 min ago" });
    expect(collectorHealth(ago(32 * 60), now, limit)).toEqual({ state: "warn", text: "Collector late · ran 32 min ago" });
    expect(collectorHealth(ago(40 * 60), now, limit)).toEqual({ state: "err", text: "Collector stopped 40 min ago" });
  });

  it("keeps the 5-minute rule for the default limit or a shorter one", () => {
    expect(collectorHealth(ago(200), now, 5 * 60_000)).toEqual({ state: "warn", text: "Collector late · ran 3 min ago" });
    expect(collectorHealth(ago(200), now, 3 * 60_000)).toEqual({ state: "warn", text: "Collector late · ran 3 min ago" });
  });
});

describe("schedulerRun", () => {
  const LATE = 180_000;
  const run = (startedS: number, finishedS: number | null, ok: boolean | null) => ({ startedAt: ago(startedS), finishedAt: finishedS === null ? null : ago(finishedS), ok });

  it("shows a run that started under 2 minutes ago and hasn't finished as running", () => {
    expect(schedulerRun(run(30, null, null), now, LATE)).toEqual({ state: "build", text: "Running now" });
    expect(schedulerRun(run(119, null, null), now, LATE)).toEqual({ state: "build", text: "Running now" });
  });

  it("calls an older unfinished run one that didn't finish", () => {
    expect(schedulerRun(run(120, null, null), now, LATE)).toEqual({ state: "err", text: "Last run didn't finish (started 2 min ago)" });
  });

  it("warns when the last run finished with problems, even if it is recent", () => {
    expect(schedulerRun(run(40, 20, false), now, LATE)).toEqual({ state: "warn", text: "Last run 20s ago · finished with problems" });
  });

  it("is ok for a recent good run, measured from when it finished", () => {
    expect(schedulerRun(run(200, 170, true), now, LATE)).toEqual({ state: "ok", text: "Last run 2 min ago" });
  });

  it("warns that a good run is late once it is older than the threshold", () => {
    expect(schedulerRun(run(200, 180, true), now, LATE)).toEqual({ state: "warn", text: "Last run 3 min ago · late" });
    expect(schedulerRun(run(27 * 3600, 27 * 3600 - 60, true), now, 26 * 3_600_000)).toEqual({ state: "warn", text: "Last run 11 Oct 14:01 · late" });
  });
});

// 1.8.1: the Schedulers card said cron-job.org was "late" 3 minutes after a run and called it "every minute", while
// ops runs it every 30 minutes with the CollectorStale rule at 40 (owner, 15 Nov). The card follows the rule now.
describe("cronJobRow", () => {
  const run = (minAgo: number) => ({ startedAt: ago(minAgo * 60 + 5), finishedAt: ago(minAgo * 60), ok: true });
  it("is on time until the CollectorStale limit, then late", () => {
    expect(cronJobRow(run(12), now, 40 * 60_000)).toMatchObject({ state: "ok", text: "Last run 12 min ago" });
    expect(cronJobRow(run(45), now, 40 * 60_000)).toMatchObject({ state: "warn", text: "Last run 45 min ago · late" });
  });
  it("names the schedule as set at cron-job.org and the limit, never 'every minute'", () => {
    const r = cronJobRow(run(1), now, 40 * 60_000);
    expect(r.help).not.toMatch(/every minute/);
    expect(r.help).toContain("Late after 40 min");
  });
  it("says when it was never set up", () => {
    expect(cronJobRow(null, now, 5 * 60_000)).toMatchObject({ state: "idle", text: "Not set up yet" });
  });
});
