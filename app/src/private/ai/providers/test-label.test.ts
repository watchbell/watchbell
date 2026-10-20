import { describe, expect, it } from "vitest";
import { testLabel } from "./test-label";

const NOW = new Date("2026-10-14T01:00:00.000Z");
describe("testLabel", () => {
  it("never tested, ok with seconds and age, or the short error", () => {
    expect(testLabel(undefined, NOW)).toEqual({ tone: "none", text: "never tested" });
    expect(testLabel({ ok: true, ms: 2300, at: "2026-10-14T00:55:00.000Z" }, NOW)).toEqual({ tone: "ok", text: "ok · 2.3 s · 5 min ago" });
    expect(testLabel({ ok: false, ms: 80, status: 404, error: "model not found (404)", at: "2026-10-14T00:59:50.000Z" }, NOW)).toEqual({ tone: "err", text: "model not found (404) · just now" });
  });
});
