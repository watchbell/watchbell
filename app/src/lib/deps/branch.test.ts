import { describe, expect, it } from "vitest";
import {
  baseCandidates, expectedBase, isStaleSource, keepProductionSource, productionCandidate, productionMismatch, productionSourceLine, productionSourceOf,
  productionSourceText, readProductionSource, scanBranchOf, scanFallbackOf, scannedBranch,
} from "./branch";

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

// Watchbell 1.2.2 (D15, incident 25 Oct): what the live production deployment was really built from. The Vercel project's
// production branch said main while production had been deployed by the CLI from web-revamp; the update PR went to main,
// was merged, and Vercel deployed stale main to production.
const now = new Date("2026-10-25T10:00:00Z");
const fresh = new Date(now.getTime() - 5 * 60_000).toISOString();
const old = new Date(now.getTime() - 31 * 60_000).toISOString();
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("productionSourceOf (the current production deployment → resources.meta.productionSource)", () => {
  it("a Git deployment: its branch and commit", () => {
    expect(productionSourceOf({ source: "git", branch: "main", sha: SHA })).toEqual({ kind: "git", ref: "main", sha: SHA });
    // A redeploy or promote of a Git deployment still carries the Git branch.
    expect(productionSourceOf({ source: "redeploy", branch: "web-revamp", sha: null })).toEqual({ kind: "git", ref: "web-revamp" });
  });
  it("the CLI is a CLI deploy (the branch the CLI ran on is kept when Vercel has it)", () => {
    expect(productionSourceOf({ source: "cli", branch: null, sha: null })).toEqual({ kind: "cli" });
    expect(productionSourceOf({ source: "cli", branch: "web-revamp", sha: SHA })).toEqual({ kind: "cli", ref: "web-revamp", sha: SHA });
  });
  // Fix round 3 (re-review r2 I1): a redeploy or promote of a CLI deployment carries only the CLI's git metadata.
  it("a redeploy or promote whose branch came only from the CLI's metadata is a CLI deploy; a dirty tree too", () => {
    expect(productionSourceOf({ source: "redeploy", branch: "main", sha: SHA, branchFrom: "cli" })).toEqual({ kind: "cli", ref: "main", sha: SHA });
    expect(productionSourceOf({ source: null, branch: "main", sha: null, branchFrom: "cli" })).toEqual({ kind: "cli", ref: "main" });
    expect(productionSourceOf({ source: "redeploy", branch: "main", sha: null, branchFrom: "github", gitDirty: true })).toEqual({ kind: "cli", ref: "main" });
    // Vercel says it's a Git build, or a Git provider names the branch: a Git source.
    expect(productionSourceOf({ source: "git", branch: "main", sha: null, branchFrom: "cli" })).toEqual({ kind: "git", ref: "main" });
    expect(productionSourceOf({ source: "redeploy", branch: "main", sha: null, branchFrom: "github" })).toEqual({ kind: "git", ref: "main" });
    expect(productionSourceOf({ source: "redeploy", branch: "main", sha: null, branchFrom: "gitSource" })).toEqual({ kind: "git", ref: "main" });
  });
  it("reads the deployment id back", () => {
    expect(readProductionSource({ kind: "cli", id: "dpl_abc123" })).toEqual({ kind: "cli", id: "dpl_abc123" });
    expect(readProductionSource({ kind: "cli", id: "bad id!" })).toEqual({ kind: "cli" });
  });
  it("a non-CLI deployment without a usable branch is unknown, not a CLI deploy (review minor 1)", () => {
    expect(productionSourceOf({ source: "git", branch: null, sha: null })).toBeNull();
    expect(productionSourceOf({ source: null, branch: null, sha: null })).toBeNull();
    expect(productionSourceOf({ source: "git", branch: "../evil", sha: "not a sha" })).toBeNull();
  });
  it("reads a stored value back with its time, and nothing else", () => {
    expect(readProductionSource({ kind: "git", ref: "main", sha: SHA, at: fresh })).toEqual({ kind: "git", ref: "main", sha: SHA, at: fresh });
    expect(readProductionSource({ kind: "cli", at: "not a time" })).toEqual({ kind: "cli" });
    for (const v of [null, undefined, "git", { kind: "svn" }, { kind: "git" }, { kind: "git", ref: "a..b" }]) expect(readProductionSource(v)).toBeNull();
  });
  it("is stale without a time or after 30 minutes", () => {
    expect(isStaleSource({ kind: "git", ref: "main", at: fresh }, now)).toBe(false);
    expect(isStaleSource({ kind: "git", ref: "main", at: old }, now)).toBe(true);
    expect(isStaleSource({ kind: "git", ref: "main" }, now)).toBe(true);
  });
  it("survives a Sync's meta rewrite", () => {
    expect(keepProductionSource({ teamId: "t", productionSource: { kind: "cli", at: fresh } })).toEqual({ productionSource: { kind: "cli", at: fresh } });
    expect(keepProductionSource({ teamId: "t" })).toEqual({});
    expect(keepProductionSource(undefined)).toEqual({});
  });
  it("reads as text for the app page", () => {
    expect(productionSourceText({ kind: "git", ref: "web-revamp" })).toBe("web-revamp (git)");
    expect(productionSourceText({ kind: "cli" })).toBe("CLI deploy");
    expect(productionSourceText({ kind: "cli", ref: "web-revamp" })).toBe("CLI deploy (from web-revamp)");
  });
});

describe("the update PR's base", () => {
  it("tries the Git branch production was built from, then the production branch, then the default branch", () => {
    expect(baseCandidates({ productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp" } }, "main")).toEqual(["web-revamp", "main"]);
    expect(baseCandidates({ productionBranch: "release", productionSource: { kind: "git", ref: "web-revamp" } }, "main")).toEqual(["web-revamp", "release", "main"]);
    expect(baseCandidates({ productionBranch: "release", productionSource: { kind: "git", ref: "main" } }, "main")).toEqual(["main"]);
    expect(baseCandidates({ productionBranch: "release", productionSource: { kind: "cli", ref: "other" } }, "main")).toEqual(["release", "main"]);
    expect(baseCandidates({ productionBranch: "../evil" }, "main")).toEqual(["main"]);
    expect(baseCandidates(null, "main")).toEqual(["main"]);
  });
  it("expectedBase: the first candidate, assumed to exist", () => {
    expect(expectedBase({ productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp" } }, "main")).toBe("web-revamp");
    expect(expectedBase({ productionBranch: "web-revamp" }, "main")).toBe("web-revamp");
    expect(expectedBase({ productionBranch: "main", productionSource: { kind: "cli" } }, "main")).toBe("main");
    expect(expectedBase({ productionBranch: "release" }, null)).toBe("release");
    expect(expectedBase(null, null)).toBeNull();
  });
});

describe("productionMismatch (says what merging into the PR's base would do)", () => {
  it("production deployed from the CLI", () => {
    expect(productionMismatch({ kind: "cli", at: fresh }, "main", now))
      .toBe("Production was deployed from the CLI, not built from main. Merging this PR would deploy main to production and replace what is live.");
    expect(productionMismatch({ kind: "cli", ref: "main", at: fresh }, "main", now)).toContain("deployed from the CLI");
  });
  it("production built from another branch (one the repository doesn't have, so the base stayed main)", () => {
    expect(productionMismatch({ kind: "git", ref: "web-revamp", at: fresh }, "main", now))
      .toBe("Production was built from web-revamp, not main. Merging this PR would deploy main to production and replace what is live.");
  });
  it("a reading older than 30 minutes (or without a time) can't confirm anything", () => {
    for (const s of [{ kind: "git", ref: "main", at: old }, { kind: "git", ref: "main" }]) {
      expect(productionMismatch(s, "main", now))
        .toBe("Watchbell can't confirm what production is built from (no reading in the last 30 minutes). Merging this PR could deploy main to production and replace what is live.");
    }
  });
  it("built from the PR's base and read lately, or never read: no mismatch (unchanged behaviour)", () => {
    expect(productionMismatch({ kind: "git", ref: "main", sha: "a".repeat(40), at: fresh }, "main", now)).toBeNull();
    expect(productionMismatch(undefined, "main", now)).toBeNull();
    expect(productionMismatch({ kind: "odd" }, "main", now)).toBeNull();
  });
  it("a base that can't be known yet: only a CLI deploy or an old reading counts", () => {
    expect(productionMismatch({ kind: "git", ref: "web-revamp", at: fresh }, null, now)).toBeNull();
    expect(productionMismatch({ kind: "cli", at: fresh }, null, now)).toBe("Production was deployed from the CLI. Merging this PR would deploy a stale branch to production and replace what is live.");
  });
});

describe("productionSourceLine (the app page, against the base the gates use)", () => {
  it("a Git branch production was built from is the PR's base: no warning, even when it isn't the production branch (review minor 2)", () => {
    expect(productionSourceLine({ kind: "git", ref: "main", at: fresh }, "main", now)).toEqual({ text: "main (git)", warning: null });
    expect(productionSourceLine({ kind: "git", ref: "web-revamp", at: fresh }, "main", now)).toEqual({ text: "web-revamp (git)", warning: null });
    expect(productionSourceLine({ kind: "git", ref: "main", at: fresh }, null, now)?.warning).toBeNull();
  });
  it("a CLI deploy or an old reading: the warning says what merging would do", () => {
    expect(productionSourceLine({ kind: "cli", ref: "main", at: fresh }, "main", now)).toEqual({
      text: "CLI deploy (from main)",
      warning: "Production was deployed from the CLI, not built from main. Merging this PR would deploy main to production and replace what is live. Update PRs open as drafts for your approval and are never merged automatically.",
    });
    expect(productionSourceLine({ kind: "git", ref: "main", at: old }, "main", now)?.warning).toContain("can't confirm");
    expect(productionSourceLine(undefined, "main", now)).toBeNull();
  });
});

describe("scannedBranch (the branch the stored scan read, from its key)", () => {
  it("a production-branch key names it; any other key is the default branch; nothing stored is unknown", () => {
    expect(scannedBranch("br:web-revamp:abc123", "main")).toBe("web-revamp");
    expect(scannedBranch("br:release/1.2:apps/web:abc", "main")).toBe("release/1.2");
    expect(scannedBranch("abc123", "main")).toBe("main");
    expect(scannedBranch("apps/web:abc123", "main")).toBe("main");
    expect(scannedBranch("odd:abc", "main")).toBe("main");
    expect(scannedBranch(null, "main")).toBeNull();
    expect(scannedBranch("br:pkg:abc", "main", "br")).toBeNull(); // a Root Directory named "br": can't tell
  });
});

describe("scanBranchOf (the branch the dependency scan reads)", () => {
  it("the Git branch production was really built from, then the project's production branch", () => {
    const meta = { productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp" } };
    expect(scanBranchOf(meta)).toBe("web-revamp");
    expect(scanFallbackOf(meta)).toBe("main");
  });
  it("a CLI deploy or no source: the project's production branch, as before", () => {
    expect(scanBranchOf({ productionBranch: "web-revamp", productionSource: { kind: "cli", ref: "other" } })).toBe("web-revamp");
    expect(scanFallbackOf({ productionBranch: "web-revamp", productionSource: { kind: "cli" } })).toBeNull();
    expect(scanBranchOf({ productionBranch: "web-revamp" })).toBe("web-revamp");
    expect(scanBranchOf(null)).toBeUndefined();
  });
});
