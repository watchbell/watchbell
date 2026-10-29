import { describe, expect, it } from "vitest";
import { offersChanges, prNumber } from "./release-notes";

describe("prNumber", () => {
  it("finds the pull request number in a squash title or a merge commit", () => {
    expect(prNumber("Fix login (#12)")).toBe(12);
    expect(prNumber("Merge pull request #7 from a/b")).toBe(7);
    expect(prNumber("chore")).toBeNull();
    expect(prNumber("see issue #3 in the notes")).toBeNull();
  });
});

describe("offersChanges", () => {
  it("only a ready production deployment with a commit", () => {
    expect(offersChanges({ target: "production", state: "ready", commitSha: "abc" })).toBe(true);
    expect(offersChanges({ target: "preview", state: "ready", commitSha: "abc" })).toBe(false);
    expect(offersChanges({ target: "production", state: "ready", commitSha: null })).toBe(false);
    expect(offersChanges({ target: "production", state: "error", commitSha: "abc" })).toBe(false);
  });
});
