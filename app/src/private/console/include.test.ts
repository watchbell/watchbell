import { describe, expect, it } from "vitest";
import { parseInclude, selectSections } from "./include";

describe("parseInclude", () => {
  it("means everything when absent or empty", () => {
    for (const raw of [null, "", "  ", ",,"]) expect(parseInclude(raw)).toEqual({ ok: true, include: ["apps", "monitors", "alerts", "advisor"] });
  });
  it("keeps the requested sections in a fixed order, ignoring case, spaces and repeats", () => {
    expect(parseInclude("Alerts, apps,alerts")).toEqual({ ok: true, include: ["apps", "alerts"] });
  });
  it("rejects an unknown section by name", () => {
    expect(parseInclude("apps,secrets")).toEqual({ ok: false, error: 'Unknown section "secrets". Use apps, monitors, alerts, advisor.' });
  });
});

describe("selectSections", () => {
  const snap = { generatedAt: "t", apps: [], monitors: { up: 1, degraded: 0, down: 0, paused: 0 }, alerts: { open: 0, critical: 0 }, advisor: [] };
  it("omits what was not asked for", () => {
    expect(Object.keys(selectSections(snap, ["alerts"]))).toEqual(["generatedAt", "alerts"]);
    expect(Object.keys(selectSections(snap, ["apps", "advisor"]))).toEqual(["generatedAt", "apps", "advisor"]);
  });
});
