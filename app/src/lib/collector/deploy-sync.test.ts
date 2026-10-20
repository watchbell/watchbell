import { describe, expect, it } from "vitest";
import { currentToFetch, deploymentChanged, MISS_BACKOFF_MS, missesAfter, pathOf, pickFlags, skippedIds } from "./deploy-sync";

const at = (h: number) => new Date(Date.UTC(2026, 9, 12, h));
const c = (id: string, h: number) => ({ id, createdAt: at(h) });

describe("pickFlags", () => {
  it("uses Vercel's current deployment and the next older READY one as previous", () => {
    expect(pickFlags([c("a", 3), c("b", 2), c("c", 1)], "b")).toEqual({ currentId: "b", previousId: "c" });
  });
  it("falls back to the newest known READY deployment when Vercel names none", () => {
    expect(pickFlags([c("c", 1), c("a", 3), c("b", 2)], null)).toEqual({ currentId: "a", previousId: "b" });
  });
  it("counts a deployment that is both fetched and stored once", () => {
    expect(pickFlags([c("a", 3), c("a", 3), c("b", 2)], "a")).toEqual({ currentId: "a", previousId: "b" });
  });
  it("has no previous when the current one is the oldest or unknown", () => {
    expect(pickFlags([c("a", 3)], "a")).toEqual({ currentId: "a", previousId: null });
    expect(pickFlags([c("a", 3), c("b", 2)], "zzz")).toEqual({ currentId: "zzz", previousId: null });
  });
  it("has neither when nothing is known", () => {
    expect(pickFlags([], null)).toEqual({ currentId: null, previousId: null });
  });
});

describe("deploymentChanged", () => {
  const base = { state: "ready", target: "production", branch: "main", commitSha: "abc", commitMessage: "m", source: "git", url: "x.vercel.app", buildingAt: at(1), readyAt: at(2) };
  it("is true for a new row and false for an identical one", () => {
    expect(deploymentChanged(undefined, base)).toBe(true);
    expect(deploymentChanged({ ...base, buildingAt: new Date(at(1)) }, base)).toBe(false);
  });
  it("is true when the state or the finish time moves", () => {
    expect(deploymentChanged({ ...base, state: "building", readyAt: null }, base)).toBe(true);
    expect(deploymentChanged({ ...base, readyAt: at(3) }, base)).toBe(true);
  });
});

describe("currentToFetch", () => {
  // The poll only asks Vercel for deployments of the last 7 days, so a production deployment that has been live for
  // months is never in it. Vercel still names it as current (project.targets.production), so it has to be fetched by id.
  const apps = [{ id: "r1", externalId: "p1" }, { id: "r2", externalId: "p2" }];
  it("asks for the current deployment that is neither polled nor stored (older than the poll window)", () => {
    const current = new Map([["p1", "dpl_old"], ["p2", "dpl_new"]]);
    expect(currentToFetch(apps, current, [{ resourceId: "r2", id: "dpl_new" }])).toEqual([{ appId: "r1", deploymentId: "dpl_old" }]);
  });
  it("asks for nothing once the row is stored, so it costs one call per app and not one per minute", () => {
    expect(currentToFetch(apps, new Map([["p1", "dpl_old"]]), [{ resourceId: "r1", id: "dpl_old" }])).toEqual([]);
  });
  it("skips an app whose production deployment is not READY (no current id) or that Vercel doesn't list", () => {
    expect(currentToFetch(apps, new Map([["p1", null]]), [])).toEqual([]);
  });
  it("does not accept the same id stored under another app", () => {
    expect(currentToFetch([apps[0]], new Map([["p1", "dpl_old"]]), [{ resourceId: "r2", id: "dpl_old" }])).toEqual([{ appId: "r1", deploymentId: "dpl_old" }]);
  });
});

describe("a current deployment that can't be fetched (I1)", () => {
  const apps = [{ id: "r1", externalId: "p1" }];
  const now = new Date("2026-10-12T10:00:00Z");
  it("is not asked for while it is on the skip list", () => {
    expect(currentToFetch(apps, new Map([["p1", "dpl_x"]]), [], new Set(["dpl_x"]))).toEqual([]);
    expect(currentToFetch(apps, new Map([["p1", "dpl_x"]]), [], new Set(["dpl_other"]))).toEqual([{ appId: "r1", deploymentId: "dpl_x" }]);
  });
  it("skips ids whose retry time is still ahead, and forgets malformed entries", () => {
    const stored = { dpl_wait: new Date(now.getTime() + 1000).toISOString(), dpl_due: new Date(now.getTime() - 1000).toISOString(), dpl_bad: "soon" };
    expect([...skippedIds(stored, now)]).toEqual(["dpl_wait"]);
    expect([...skippedIds(undefined, now)]).toEqual([]);
    expect([...skippedIds("nonsense", now)]).toEqual([]);
  });
  it("records a miss for about 6 hours and drops the expired ones", () => {
    expect(MISS_BACKOFF_MS).toBe(6 * 3_600_000);
    const before = { dpl_old: new Date(now.getTime() - 1000).toISOString(), dpl_keep: new Date(now.getTime() + 5000).toISOString() };
    expect(missesAfter(before, ["dpl_new"], now)).toEqual({ dpl_keep: before.dpl_keep, dpl_new: new Date(now.getTime() + MISS_BACKOFF_MS).toISOString() });
  });
});

describe("pathOf", () => {
  it("returns the path, or / for a broken url", () => {
    expect(pathOf("https://a.dev/health")).toBe("/health");
    expect(pathOf("not a url")).toBe("/");
  });
});
