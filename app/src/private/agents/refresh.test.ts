import { describe, expect, it } from "vitest";
import { AGENTS_REFRESH_MS, agentsRefreshDue } from "./refresh";

describe("agentsRefreshDue", () => {
  it("refreshes every 15 s", () => {
    expect(AGENTS_REFRESH_MS).toBe(15_000);
  });
  it("only while the tab is visible, online and nothing holds the page", () => {
    expect(agentsRefreshDue({ visible: true, online: true, held: false })).toBe(true);
    expect(agentsRefreshDue({ visible: false, online: true, held: false })).toBe(false);
    expect(agentsRefreshDue({ visible: true, online: false, held: false })).toBe(false);
    expect(agentsRefreshDue({ visible: true, online: true, held: true })).toBe(false);
  });
});
