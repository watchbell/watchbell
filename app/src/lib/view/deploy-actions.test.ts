import { describe, expect, it } from "vitest";
import { actionsFor, appDeployTargets, confirmCopy, deployRole, rowRoles } from "./deploy-actions";

const at = (h: number) => new Date(Date.UTC(2026, 9, 13, h));
const prod = (id: string, h: number, state: "ready" | "building" | "error" | "canceled" = "ready") => ({ id, state, target: "production" as const, createdAt: at(h) });
// Production READY history: a (oldest) … d (newest).
const production = [prod("d", 4), prod("c", 3), prod("b", 2), prod("a", 1)];

describe("deployRole", () => {
  it("building beats everything, even the current id", () => {
    expect(deployRole(prod("x", 9, "building"), "x", production)).toBe("building");
    expect(deployRole({ ...prod("y", 9, "building"), target: "preview" }, "c", production)).toBe("building");
  });
  it("the deployment equal to currentId is current", () => {
    expect(deployRole(prod("c", 3), "c", production)).toBe("current");
  });
  it("only the newest READY production deployment older than the current one is previous", () => {
    expect(deployRole(prod("b", 2), "c", production)).toBe("previous");
    expect(deployRole(prod("a", 1), "c", production)).toBe("other");
  });
  it("a READY production deployment newer than the current one is staged (what a roll back leaves)", () => {
    expect(deployRole(prod("d", 4), "c", production)).toBe("staged");
  });
  it("a preview is a preview, a failed build is failed", () => {
    expect(deployRole({ ...prod("p", 5), target: "preview" }, "c", production)).toBe("preview");
    expect(deployRole(prod("e", 5, "error"), "c", production)).toBe("failed");
    expect(deployRole(prod("k", 5, "canceled"), "c", production)).toBe("other");
  });
  it("only a READY preview is a preview (slice 2: it can be promoted); a canceled one is other", () => {
    expect(deployRole({ ...prod("p", 5, "canceled"), target: "preview" }, "c", production)).toBe("other");
    expect(deployRole({ ...prod("p", 5, "error"), target: "preview" }, "c", production)).toBe("failed");
    expect(deployRole({ ...prod("p", 5), target: "preview" }, null, production)).toBe("preview");
  });
  it("without a known current deployment nothing can be placed", () => {
    expect(deployRole(prod("b", 2), null, production)).toBe("other");
    expect(deployRole(prod("b", 2), "zzz", production)).toBe("other");
  });
  it("ignores production rows that aren't READY when finding previous", () => {
    expect(deployRole(prod("a", 1), "c", [prod("c", 3), prod("b", 2, "error"), prod("a", 1)])).toBe("previous");
  });
});

describe("actionsFor", () => {
  it("matches the mockup's depRow lists (Visit and build logs are added by the row)", () => {
    expect(actionsFor("building")).toEqual(["Cancel"]);
    expect(actionsFor("current")).toEqual(["Redeploy"]);
    expect(actionsFor("previous")).toEqual(["Roll back to this"]);
    expect(actionsFor("staged")).toEqual(["Promote"]);
    for (const r of ["failed", "other"] as const) expect(actionsFor(r)).toEqual([]);
  });
  it("a ready preview offers Promote to production, except while the app is rolled back (it would stay staged)", () => {
    expect(actionsFor("preview")).toEqual(["Promote to production"]);
    expect(actionsFor("preview", true)).toEqual([]);
  });
  it("offers no Redeploy while the app is rolled back (the server refuses it: the build would stay staged)", () => {
    expect(actionsFor("current", true)).toEqual([]);
    expect(actionsFor("staged", true)).toEqual(["Promote"]);
    expect(actionsFor("previous", true)).toEqual(["Roll back to this"]);
  });
});

const row = (externalId: string, appId: string, h: number, extra: Partial<{ state: string; target: string | null; isCurrent: boolean }> = {}) => ({
  externalId, appId, state: "ready", target: "production", createdAt: at(h), isCurrent: false, ...extra,
});

describe("rowRoles and appDeployTargets", () => {
  const rows = [
    row("dpl_new", "app1", 6), // pushed after a roll back: staged
    row("dpl_b", "app1", 5, { state: "building" }),
    row("dpl_cur", "app1", 4, { isCurrent: true }),
    row("dpl_prev", "app1", 3),
    row("dpl_old", "app1", 2),
    row("dpl_x", "app2", 5, { isCurrent: true }),
    row("dpl_pv", "app2", 6, { target: "preview" }),
  ];
  it("places each row within its own app", () => {
    expect(Object.fromEntries(rowRoles(rows))).toEqual({
      dpl_new: "staged", dpl_b: "building", dpl_cur: "current", dpl_prev: "previous", dpl_old: "other", dpl_x: "current", dpl_pv: "preview",
    });
  });
  it("names an app's current, previous and newest staged deployment", () => {
    expect(appDeployTargets(rows.filter((r) => r.appId === "app1"))).toEqual({ currentId: "dpl_cur", previousId: "dpl_prev", stagedId: "dpl_new" });
    expect(appDeployTargets(rows.filter((r) => r.appId === "app2"))).toEqual({ currentId: "dpl_x", previousId: null, stagedId: null });
    expect(appDeployTargets([])).toEqual({ currentId: null, previousId: null, stagedId: null });
  });
});

describe("confirmCopy (mockup confirmFor)", () => {
  it("names the target in the title and the effect in the body", () => {
    expect(confirmCopy("Redeploy", "portfolio-site", "3f2a91c")).toMatchObject({ title: "Redeploy portfolio-site?", cta: "Redeploy", danger: false });
    expect(confirmCopy("Redeploy", "w", "s").body).toContain("100 deployments a day on Hobby");
    expect(confirmCopy("Roll back", "web-Quillpad", "9be1c04")).toMatchObject({ title: "Roll back web-Quillpad?", cta: "Roll back", danger: true });
    expect(confirmCopy("Roll back to this", "web-Quillpad", "3f2a91c")).toMatchObject({ title: "Roll back web-Quillpad to 3f2a91c?", cta: "Roll back", danger: true });
    expect(confirmCopy("Promote", "web", "5be0d17")).toMatchObject({ title: "Promote web 5be0d17?", cta: "Promote", danger: false });
    expect(confirmCopy("Promote", "web", "5be0d17").body).toContain("this undoes a roll back");
    expect(confirmCopy("Cancel", "acme-shop", "a3f91c2")).toEqual({
      title: "Cancel this build?", cta: "Cancel build", danger: true,
      body: "The running build of acme-shop a3f91c2 stops. The current production deployment stays live.",
    });
  });
  it("Promote to production (a preview, slice 2) says it rebuilds with the production variables", () => {
    const c = confirmCopy("Promote to production", "web", "5be0d17");
    expect(c).toMatchObject({ title: "Promote web 5be0d17 to production?", cta: "Promote to production", danger: true });
    expect(c.body).toContain("production environment variables");
    expect(c.body).toContain("100 deployments a day on Hobby");
  });
});
