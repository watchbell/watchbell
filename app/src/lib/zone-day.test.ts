import { describe, expect, it } from "vitest";
import { zoneMidnight } from "./zone-day";

// Watchbell 1.7.1 (review M-12): the instant a day starts in a zone, right on both sides of a daylight-saving change.
describe("zoneMidnight", () => {
  it("is 17:00 UTC the day before in WIB", () => {
    expect(zoneMidnight("2026-11-01", "Asia/Jakarta").toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });

  it("follows the offset of the day itself around a DST change", () => {
    // Sydney: summer time ends 5 Apr (midnight still +11) and starts 4 Oct (midnight still +10).
    expect(zoneMidnight("2026-04-05", "Australia/Sydney").toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(zoneMidnight("2026-10-04", "Australia/Sydney").toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(zoneMidnight("2026-09-27", "Pacific/Auckland").toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(zoneMidnight("2026-03-30", "Europe/Berlin").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });
});
