import { describe, expect, it } from "vitest";
import { isStale } from "./staleness";

const now = new Date("2026-10-12T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
describe("isStale", () => {
  it("is stale when the minute collector never ran", () => expect(isStale(null, now)).toBe(true));
  it("is fresh after 4 minutes", () => expect(isStale(ago(4), now)).toBe(false));
  it("is fresh at exactly 5 minutes", () => expect(isStale(ago(5), now)).toBe(false));
  it("is stale after 6 minutes", () => expect(isStale(ago(6), now)).toBe(true));
});
