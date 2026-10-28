import { describe, expect, it } from "vitest";
import { isStale, STALE_MS, staleLimitMs } from "./staleness";

const now = new Date("2026-10-12T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
describe("isStale", () => {
  it("is stale when the minute collector never ran", () => expect(isStale(null, now)).toBe(true));
  it("is fresh after 4 minutes", () => expect(isStale(ago(4), now)).toBe(false));
  it("is fresh at exactly 5 minutes", () => expect(isStale(ago(5), now)).toBe(false));
  it("is stale after 6 minutes", () => expect(isStale(ago(6), now)).toBe(true));
});

describe("isStale with the CollectorStale rule's threshold", () => {
  it("follows a 12-minute rule: a 5-minute schedule is never stale between runs", () => {
    expect(isStale(ago(6), now, staleLimitMs(12))).toBe(false);
    expect(isStale(ago(12), now, staleLimitMs(12))).toBe(false);
    expect(isStale(ago(13), now, staleLimitMs(12))).toBe(true);
  });
  it("falls back to 5 minutes without a usable threshold", () => {
    for (const t of [null, undefined, 0, -3, Number.NaN]) expect(staleLimitMs(t)).toBe(STALE_MS);
    expect(staleLimitMs(3)).toBe(180_000);
  });
});
