import { describe, expect, it } from "vitest";
import { deployDays, deployTicks } from "./deploy-marks";

const HALF = 30 * 60_000;
const first = Date.UTC(2026, 9, 11, 15, 0); // 48 half-hour buckets from 11 Oct 15:00 UTC (22:00 WIB)
describe("deployTicks (A1)", () => {
  it("places a deploy at its fractional bucket, scaled to the chart width; the title is WIB", () => {
    const at = new Date(first + 47 * HALF); // the last bucket start: 12 Oct 14:30 UTC = 21:30 WIB
    expect(deployTicks([{ at, sha: "c8202c1abc", state: "ready" }], first, HALF, 48, 400)).toEqual([{ x: 400, title: "Deployed c8202c1 · 21:30" }]);
    expect(deployTicks([{ at: new Date(first + 23.5 * HALF), sha: null, state: "ready" }], first, HALF, 48, 470)[0].x).toBe(235);
  });
  it("says when a deploy failed or is still building, and drops deploys outside the window", () => {
    const at = new Date(first + 10 * HALF); // 11 Oct 20:00 UTC = 12 Oct 03:00 WIB
    expect(deployTicks([{ at, sha: "0d3c8aa", state: "error" }], first, HALF, 48, 400)[0].title).toBe("Deploy failed 0d3c8aa · 03:00");
    expect(deployTicks([{ at, sha: "a3f91c2", state: "building" }], first, HALF, 48, 400)[0].title).toBe("Deploying a3f91c2 · 03:00");
    expect(deployTicks([{ at: new Date(first - 1), sha: "x", state: "ready" }, { at: new Date(first + 48 * HALF), sha: "y", state: "ready" }], first, HALF, 48, 400)).toEqual([]);
  });
});

describe("deployDays (A1)", () => {
  it("groups production deploys by WIB day", () => {
    const m = deployDays([
      { at: new Date("2026-10-12T17:30:00Z"), sha: "aaaaaaa1", state: "ready" }, // 13 Oct 00:30 WIB
      { at: new Date("2026-10-12T09:00:00Z"), sha: "bbbbbbb2", state: "ready" },
      { at: new Date("2026-10-12T10:00:00Z"), sha: "ccccccc3", state: "error" },
    ]);
    expect(m.get("2026-10-13")).toBe("aaaaaaa");
    expect(m.get("2026-10-12")).toBe("bbbbbbb, ccccccc (failed)");
  });
});
