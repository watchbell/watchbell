import { describe, expect, it } from "vitest";
import { agoShort, durationText, wibTime } from "./time-text";

const NOW = new Date("2026-10-13T09:00:00.000Z"); // 16:00 WIB

describe("time-text", () => {
  it("wibTime: the WIB clock, with the date when it isn't today", () => {
    expect(wibTime(new Date("2026-10-13T02:05:00Z"), NOW)).toBe("09:05 WIB");
    expect(wibTime(new Date("2026-10-14T03:00:00Z"), NOW)).toBe("14 Oct 10:00 WIB");
  });
  it("agoShort: just now, minutes, hours (under 48), then days", () => {
    expect(agoShort(new Date(NOW.getTime() - 20_000), NOW)).toBe("just now");
    expect(agoShort(new Date(NOW.getTime() + 60_000), NOW)).toBe("just now");
    expect(agoShort(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5 min ago");
    expect(agoShort(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(agoShort(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe("3 days ago");
  });
  it("durationText: seconds, then minutes and seconds", () => {
    expect(durationText(4_400)).toBe("4 s");
    expect(durationText(120_000)).toBe("2 min");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(-5)).toBe("0 s");
  });
});
