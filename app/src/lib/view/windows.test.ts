import { describe, expect, it } from "vitest";
import { BAR_DAYS, UPTIME_DAYS } from "./uptime";
import { PAGE_ROWS, WINDOWS } from "./windows";

describe("R8 bounds", () => {
  it("caps the rows a page reads", () => {
    expect(PAGE_ROWS.events).toBeLessThanOrEqual(200);
    expect(PAGE_ROWS.deployments).toBeLessThanOrEqual(200);
    expect(PAGE_ROWS.apps).toBeLessThanOrEqual(200);
    expect(PAGE_ROWS.monitors).toBeLessThanOrEqual(200);
    expect(PAGE_ROWS.databases).toBeLessThanOrEqual(200);
  });
  it("reads raw checks for at most 7 days and rollups for at most 90", () => {
    expect(WINDOWS.rawChecksMs).toBeLessThanOrEqual(7 * 86_400_000);
    expect(BAR_DAYS).toBeLessThanOrEqual(90);
    expect(UPTIME_DAYS).toBeLessThanOrEqual(BAR_DAYS);
  });
});
