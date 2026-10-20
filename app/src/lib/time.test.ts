import { describe, expect, it } from "vitest";
import { ago, clock, dayMonth, expires, lastSync, sameDay } from "./time";

const at = (iso: string) => new Date(iso);

describe("WIB helpers", () => {
  it("formats the clock and the day in Asia/Jakarta", () => {
    expect(clock(at("2026-10-12T20:30:00Z"))).toBe("03:30");
    expect(dayMonth(at("2026-10-12T20:30:00Z"))).toBe("13 Oct");
  });

  it("writes September as Sep, not Sept", () => {
    expect(dayMonth(at("2026-09-02T05:00:00Z"))).toBe("2 Sep");
    expect(dayMonth(at("2026-09-30T20:00:00Z"))).toBe("1 Oct"); // 03:00 WIB next day
  });

  it("compares calendar days in WIB, not UTC", () => {
    expect(sameDay(at("2026-10-12T16:00:00Z"), at("2026-10-12T17:30:00Z"))).toBe(false); // 23:00 vs 00:30 WIB
    expect(sameDay(at("2026-10-12T17:30:00Z"), at("2026-10-13T16:00:00Z"))).toBe(true);
  });
});

describe("lastSync", () => {
  const now = at("2026-10-12T10:00:00Z"); // 17:00 WIB
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("says never without a date", () => expect(lastSync(null, now)).toBe("never"));
  it("says just now under a minute", () => expect(lastSync(ago(20_000), now)).toBe("just now"));
  it("counts minutes under an hour", () => expect(lastSync(ago(2 * 60_000), now)).toBe("2 min ago"));
  it("shows today HH:MM for the same WIB day", () => expect(lastSync(at("2026-10-12T02:00:00Z"), now)).toBe("today 09:00"));
  it("shows D MMM HH:MM for older days", () => expect(lastSync(at("2026-10-01T20:30:00Z"), now)).toBe("2 Oct 03:30"));
  it("uses the WIB day boundary for today", () => expect(lastSync(at("2026-10-11T16:59:00Z"), now)).toBe("11 Oct 23:59"));
});

describe("expires", () => {
  const now = at("2026-10-12T10:00:00Z");
  const from = (ms: number) => new Date(now.getTime() + ms);
  const H = 3_600_000;
  it("shows a dash without a date", () => expect(expires(null, now)).toBe("—"));
  it("counts whole days ahead, rounding down", () => expect(expires(from(83 * 24 * H + 23 * H), now)).toBe("in 83 days"));
  it("uses the singular for one day", () => expect(expires(from(30 * H), now)).toBe("in 1 day"));
  it("says today when less than a day is left", () => expect(expires(from(5 * H), now)).toBe("today"));
  it("says expired 1 day ago for anything already past", () => {
    expect(expires(from(-12 * H), now)).toBe("expired 1 day ago");
    expect(expires(from(-30 * H), now)).toBe("expired 1 day ago");
  });
  it("counts whole days past", () => expect(expires(from(-50 * H), now)).toBe("expired 2 days ago"));
});

describe("ago", () => {
  const now = at("2026-10-12T10:00:00Z"); // 17:00 WIB
  const back = (s: number) => new Date(now.getTime() - s * 1000);
  it("clamps a date in the future to 0s", () => expect(ago(back(-30), now)).toBe("0s ago"));
  it("counts seconds under a minute", () => {
    expect(ago(back(0), now)).toBe("0s ago");
    expect(ago(back(59), now)).toBe("59s ago");
  });
  it("counts whole minutes under an hour", () => {
    expect(ago(back(60), now)).toBe("1 min ago");
    expect(ago(back(3599), now)).toBe("59 min ago");
  });
  it("shows today HH:MM in WIB from an hour on", () => expect(ago(back(3600), now)).toBe("today 16:00"));
  it("shows D MMM HH:MM for an earlier WIB day", () => expect(ago(at("2026-10-11T16:59:00Z"), now)).toBe("11 Oct 23:59"));
});
