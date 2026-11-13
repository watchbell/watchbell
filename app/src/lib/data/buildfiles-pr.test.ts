import { describe, expect, it, vi } from "vitest";
import type { BuildFile } from "@/lib/buildfiles/templates";
import { type BuildFilesPrDeps, openBuildFilesPr } from "./buildfiles-pr";

const actor = { id: "mem-1", userId: "user-1" };
const SHA = "b".repeat(40);
const files: BuildFile[] = [
  { path: "Dockerfile", text: "FROM a" }, { path: ".dockerignore", text: "x" }, { path: "docker-compose.yml", text: "y" },
  { path: ".github/workflows/ci.yml", text: "z" }, { path: "k8s.yaml", text: "k" },
];

function deps(o: Partial<BuildFilesPrDeps> & { existing?: string[] } = {}) {
  const put = vi.fn(async (_t: string, _r: string, _b: string, _d: string, path: string) => ({ ok: true as const, data: (o.existing ?? []).includes(path) ? "exists" as const : "created" as const }));
  const pull = vi.fn(async () => ({ ok: true as const, data: { number: 12, url: "https://github.com/o/r/pull/12" } }));
  const branch = vi.fn(async () => ({ ok: true as const, data: true as const }));
  const fin = vi.fn(async (out: { message: string }) => ({ ok: true as const, message: out.message }));
  const d: BuildFilesPrDeps = {
    writeAccount: async () => ({ id: "acc-1", token: "w" }),
    generate: async () => ({ ok: true, data: { files, facts: { guessed: ["Node version"] } as never, repo: "o/r", branch: "main" } }),
    appName: async () => "portfolio",
    repoInfo: async () => ({ ok: true, data: { defaultBranch: "main", canPush: true } }),
    branchHead: async () => ({ ok: true, data: SHA }),
    exists: async (_t, _r, path) => (o.existing ?? []).includes(path),
    createBranch: branch, putNewFile: put, createPull: pull, finish: fin as never,
    openBuildFilesPull: async () => ({ ok: true, data: null }),
    random: () => "0123abcd",
    ...o,
  };
  return { d, put, pull, branch, fin };
}

describe("openBuildFilesPr", () => {
  it("opens a pull request on its own branch with every file", async () => {
    const { d, put, pull, branch, fin } = deps();
    const r = await openBuildFilesPr(actor, "app", d);
    expect(branch).toHaveBeenCalledWith("w", "o/r", "watchbell/build-files-0123abcd", SHA, "main");
    expect(put).toHaveBeenCalledTimes(5);
    const [, , , , title, body] = pull.mock.calls[0] as unknown as string[];
    expect(title).toBe("Add build files (Watchbell)");
    expect(body).toContain("- `Dockerfile`");
    expect(body).toContain("Guessed: Node version.");
    expect(body).not.toContain("Skipped");
    expect(fin.mock.calls[0][0]).toMatchObject({ done: true, audit: { message: "Opened build files PR #12 for portfolio", resourceId: "app" } });
    expect(r).toEqual({ ok: true, message: "Pull request #12 opened.", data: { number: 12, url: "https://github.com/o/r/pull/12", skipped: [] } });
  });

  it("leaves files that already exist alone, and says so", async () => {
    const { d, put, pull } = deps({ existing: ["Dockerfile", ".github/workflows/ci.yml"] });
    const r = await openBuildFilesPr(actor, "app", d);
    expect(put).toHaveBeenCalledTimes(3);
    expect((pull.mock.calls[0] as unknown as string[])[5]).toContain("Skipped (already in the repository): `Dockerfile`, `.github/workflows/ci.yml`");
    expect(r.ok && r.data?.skipped).toEqual(["Dockerfile", ".github/workflows/ci.yml"]);
  });

  it("counts a file created meanwhile as skipped", async () => {
    const { d } = deps({ putNewFile: async (_t, _r, _b, _d, path) => ({ ok: true, data: path === "k8s.yaml" ? "exists" : "created" }) });
    const r = await openBuildFilesPr(actor, "app", d);
    expect(r.ok && r.data?.skipped).toEqual(["k8s.yaml"]);
  });

  it("creates nothing when every file already exists", async () => {
    const { d, branch, pull } = deps({ existing: files.map((f) => f.path) });
    expect(await openBuildFilesPr(actor, "app", d)).toEqual({ ok: false, error: "Every build file already exists in the repository." });
    expect(branch).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });

  it("needs the PR-write token and a linked repository", async () => {
    expect(await openBuildFilesPr(actor, "app", deps({ writeAccount: async () => null }).d)).toMatchObject({ ok: false, error: expect.stringContaining("GitHub PR-write token is needed") });
    expect(await openBuildFilesPr(actor, "app", deps({ generate: async () => ({ ok: true, data: { files, facts: { guessed: [] } as never, repo: null, branch: null } }) }).d))
      .toEqual({ ok: false, error: "Link a repository first." });
  });

  it("passes a GitHub failure through the finisher", async () => {
    const { d, fin } = deps({ createBranch: async () => ({ ok: false, kind: "scope", error: "no" }) });
    await openBuildFilesPr(actor, "app", d);
    expect(fin.mock.calls[0][0]).toMatchObject({ done: false, failed: { kind: "scope" }, audit: { message: "Build files PR failed · portfolio" } });
  });
});

describe("review fix C2", () => {
  it("opens the pull request without the CI file when the token can't write workflows, and says why", async () => {
    const { d, pull } = deps({
      putNewFile: async (_t, _r, _b, _d, path) => (path === ".github/workflows/ci.yml" ? { ok: false, kind: "scope", error: "403" } : { ok: true, data: "created" }),
    });
    const r = await openBuildFilesPr(actor, "app", d);
    expect(r.ok && r.data?.skipped).toEqual([".github/workflows/ci.yml"]);
    expect((pull.mock.calls[0] as unknown as string[])[5]).toContain("Not added: `.github/workflows/ci.yml` — the GitHub PR-write token needs Workflows: Read and write to add it. Copy it from the Build files card instead.");
  });
});

describe("minor fix M5", () => {
  it("doesn't open a second build-files pull request while one is open", async () => {
    const { d, branch } = deps({ openBuildFilesPull: async () => ({ ok: true, data: { number: 7, url: "https://github.com/o/r/pull/7" } }) });
    expect(await openBuildFilesPr(actor, "app", d)).toEqual({ ok: false, error: "Pull request #7 with build files is already open. Merge or close it first." });
    expect(branch).not.toHaveBeenCalled();
  });
  it("names the branch it leaves behind when a write fails half-way", async () => {
    const { d, fin } = deps({ putNewFile: async (_t, _r, _b, _d, path) => (path === "docker-compose.yml" ? { ok: false, kind: "transient", error: "GitHub returned an error (502)." } : { ok: true, data: "created" }) });
    await openBuildFilesPr(actor, "app", d);
    expect(fin.mock.calls[0][0]).toMatchObject({ done: false, failed: { error: "GitHub returned an error (502). Branch watchbell/build-files-0123abcd keeps the files written so far; delete it on GitHub, or open a pull request from it." } });
  });
});
