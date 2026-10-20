import { describe, expect, it } from "vitest";
import { isActionsRepo, LOCKFILE_EVENT, lockfilePayload, parseActionsSetting, WORKFLOW_YAML } from "./actions-lockfile";

describe("lockfile via GitHub Actions", () => {
  it("accepts owner/name only", () => {
    expect(isActionsRepo("Acme/watchpost-actions")).toBe(true);
    for (const bad of ["watchpost-actions", "a/b/c", "../x/y", "a/..", "", 5, null]) expect(isActionsRepo(bad)).toBe(false);
    expect(parseActionsSetting({ repo: "Acme/watchpost-actions" })).toEqual({ repo: "Acme/watchpost-actions" });
    expect(parseActionsSetting({ repo: "nope" })).toEqual({ repo: null });
    expect(parseActionsSetting(null)).toEqual({ repo: null });
  });

  it("builds the payload only for Watchpost's own branches and a package-lock.json path", () => {
    const ok = { repo: "Acme/shortly", branch: "watchpost/deps-0a1b2c3d", lockfilePath: "package-lock.json", prNumber: 4 };
    expect(lockfilePayload(ok)).toEqual({ repo: "Acme/shortly", branch: "watchpost/deps-0a1b2c3d", lockfile: "package-lock.json", pr: 4 });
    expect(lockfilePayload({ ...ok, lockfilePath: null })?.lockfile).toBe("package-lock.json");
    expect(lockfilePayload({ ...ok, lockfilePath: "app/package-lock.json" })?.lockfile).toBe("app/package-lock.json");
    expect(lockfilePayload({ ...ok, branch: "main" })).toBeNull();
    expect(lockfilePayload({ ...ok, lockfilePath: "../package-lock.json" })).toBeNull();
    expect(lockfilePayload({ ...ok, lockfilePath: "yarn.lock" })).toBeNull();
    expect(lockfilePayload({ ...ok, prNumber: 0 })).toBeNull();
  });

  it("the workflow listens to the event, reads inputs only through env, and never runs install scripts", () => {
    expect(WORKFLOW_YAML).toContain(`types: [${LOCKFILE_EVENT}]`);
    expect(WORKFLOW_YAML).toContain("--ignore-scripts");
    expect(WORKFLOW_YAML).toContain("permissions:\n  contents: read");
    // ${{ }} only in env/with blocks, never inside a run script
    const runBlocks = WORKFLOW_YAML.split(/\n\s+- (?:name|uses):/).filter((b) => b.includes("run: |"));
    for (const b of runBlocks) expect(b.split("run: |")[1]).not.toContain("${{");
    expect(WORKFLOW_YAML).toContain("^watchpost/deps-[0-9a-f]{8}$");
  });
});
