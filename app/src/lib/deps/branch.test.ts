import { describe, expect, it } from "vitest";
import { productionCandidate } from "./branch";

// Watchbell 1.2.1 (fix round 1): the branch Vercel deploys to production is the one the scan reads and the update PR
// targets, when it is a plain branch name other than the default (whether it exists is asked of GitHub).
describe("productionCandidate", () => {
  it("is the production branch when it is a plain ref other than the default branch", () => {
    expect(productionCandidate("web-revamp", "main")).toBe("web-revamp");
    expect(productionCandidate("release/1.2", "main")).toBe("release/1.2");
    expect(productionCandidate("web-revamp", null)).toBe("web-revamp");
  });
  it("is null for the default branch, nothing, or anything that isn't a plain ref", () => {
    for (const v of ["main", null, undefined, "", 7, "../evil", "a..b", "/x", "x/", "has space"]) expect(productionCandidate(v, "main")).toBeNull();
  });
});
