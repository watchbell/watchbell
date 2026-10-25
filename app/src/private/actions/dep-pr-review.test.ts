import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/extensions", () => ({ extensions: { nav: [], palette: [] } }));
const gh = vi.hoisted(() => ({ tokenLogin: vi.fn(), pullFiles: vi.fn(), pullCommits: vi.fn(), commitFiles: vi.fn(), manifestAt: vi.fn(), lockfileAt: vi.fn() }));
vi.mock("@/lib/providers/github-write", async (orig) => ({ ...(await orig<object>()), ...gh }));

import { unexpectedChange } from "@/lib/deps/pr-watch";
import { reviewPr } from "./dep-pr-watch-db";

// Watchbell 1.2.1 (audit M1): what reviewPr gathers for the allow-list.
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const ok = <T>(data: T) => ({ ok: true as const, data });
const row = (o: object = {}) => ({
  id: "r", repoId: "repo", appId: null, proposalId: null, number: 7, branch: "watchpost/deps-0a1b2c3d", baseBranch: "main", headSha: SHA2,
  title: "t", packages: ["next"], auto: true, stage: "checks" as const, smokeMode: null, previewReadyAt: null, openedAt: new Date(),
  fullName: "o/r", appName: null, meta: { rootDirectory: "apps/web" }, lockfilePath: null, ...o,
});

beforeEach(() => {
  for (const f of Object.values(gh)) f.mockReset();
  gh.tokenLogin.mockResolvedValue(ok("owner"));
  gh.pullFiles.mockResolvedValue(ok([{ filename: "apps/web/package.json", previous: null }, { filename: "apps/web/package-lock.json", previous: null }]));
  gh.pullCommits.mockResolvedValue(ok([
    { sha: SHA1, login: "owner", name: "Owner", email: "o@x", message: "Watchbell: update next" },
    { sha: SHA2, login: null, name: "watchbell[bot]", email: "watchbell-bot@users.noreply.github.com", message: "chore(deps): update package-lock.json (Watchbell)" },
  ]));
  gh.commitFiles.mockResolvedValue(ok(["apps/web/package-lock.json"]));
  gh.manifestAt.mockImplementation(async (_t: string, _f: string, ref: string) =>
    ok({ sha: "b", text: JSON.stringify({ dependencies: { next: ref === "main" ? "15.0.3" : "15.0.5" } }) }));
  gh.lockfileAt.mockImplementation(async (_t: string, _f: string, ref: string) => {
    const v = ref === "main" ? "15.0.3" : "15.0.5";
    return ok(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/next": { version: v, resolved: `https://registry.npmjs.org/next/-/next-${v}.tgz`, integrity: `sha512-${"a".repeat(86)}==` } } }));
  });
});

describe("reviewPr", () => {
  // Review I4: a forged "own" commit that adds an install script is caught by the content check.
  it("compares package.json at the base and the recorded head", async () => {
    gh.manifestAt.mockImplementation(async (_t: string, _f: string, ref: string) =>
      ok({ sha: "b", text: JSON.stringify(ref === "main" ? { dependencies: { next: "15.0.3" } } : { dependencies: { next: "15.0.5" }, scripts: { postinstall: "x" } }) }));
    const r = await reviewPr(`tok-${Math.random()}`, row() as never);
    expect(gh.manifestAt).toHaveBeenCalledWith(expect.any(String), "o/r", SHA2, {}, "apps/web/package.json");
    expect(unexpectedChange(r!)).toBe("unexpected change in package.json beyond the bumped versions");
  });

  it("uses the app's Root Directory, reads files only of commits that aren't the token's own, and passes the allow-list", async () => {
    const r = await reviewPr(`tok-${Math.random()}`, row() as never);
    expect(r).toMatchObject({ manifest: "apps/web/package.json", lockfile: "apps/web/package-lock.json", tokenLogin: "owner" });
    expect(gh.commitFiles).toHaveBeenCalledTimes(1);
    expect(gh.commitFiles).toHaveBeenCalledWith(expect.any(String), "o/r", SHA2);
    expect(unexpectedChange(r!)).toBeNull();
  });

  // Review T2b-fix I-1: the attack moved to package-lock.json (resolved → an attacker's tarball, version unchanged).
  it("compares the lockfile at the base and the recorded head, and refuses an off-registry tarball", async () => {
    const sri = `sha512-${"a".repeat(86)}==`;
    const lock = (resolved: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/next": { version: "15.0.5", resolved, integrity: sri } } });
    gh.lockfileAt.mockImplementation(async (_t: string, _f: string, ref: string) =>
      ok(lock(ref === "main" ? "https://registry.npmjs.org/next/-/next-15.0.5.tgz" : "https://attacker.example/x.tgz")));
    const r = await reviewPr(`tok-${Math.random()}`, row() as never);
    expect(gh.lockfileAt).toHaveBeenCalledWith(expect.any(String), "o/r", "main", "apps/web/package-lock.json");
    expect(gh.lockfileAt).toHaveBeenCalledWith(expect.any(String), "o/r", SHA2, "apps/web/package-lock.json");
    expect(unexpectedChange(r!)).toBe("unexpected lockfile change next");
    gh.lockfileAt.mockResolvedValue({ ok: false, kind: "transient", error: "x" });
    expect(await reviewPr(`tok-${Math.random()}`, row() as never)).toBeNull();
  });

  it("reads no lockfile when the PR doesn't change it; refuses a lockfile it can't check", async () => {
    gh.pullFiles.mockResolvedValue(ok([{ filename: "apps/web/package.json", previous: null }]));
    gh.pullCommits.mockResolvedValue(ok([{ sha: SHA2, login: "owner", name: "Owner", email: "o@x", message: "m" }]));
    expect(unexpectedChange((await reviewPr(`tok-${Math.random()}`, row() as never))!)).toBeNull();
    expect(gh.lockfileAt).not.toHaveBeenCalled();
    gh.pullFiles.mockResolvedValue(ok([{ filename: "package.json", previous: null }, { filename: "pnpm-lock.yaml", previous: null }]));
    const r = await reviewPr(`tok-${Math.random()}`, row({ meta: {}, lockfilePath: "pnpm-lock.yaml" }) as never);
    expect(unexpectedChange(r!)).toBe("unexpected lockfile change pnpm-lock.yaml (only package-lock.json can be checked)");
    expect(gh.lockfileAt).not.toHaveBeenCalled();
  });

  it("takes the scan's lockfile path, and answers null when GitHub can't be read", async () => {
    const r = await reviewPr(`tok-${Math.random()}`, row({ meta: {}, lockfilePath: "package-lock.json" }) as never);
    expect(r).toMatchObject({ manifest: "package.json", lockfile: "package-lock.json", lockfileRequired: true });
    gh.pullFiles.mockResolvedValue({ ok: false, kind: "transient", error: "x" });
    expect(await reviewPr(`tok-${Math.random()}`, row() as never)).toBeNull();
    gh.tokenLogin.mockResolvedValue({ ok: false, kind: "auth", error: "x" });
    expect(await reviewPr(`tok-${Math.random()}`, row() as never)).toBeNull();
  });
});
