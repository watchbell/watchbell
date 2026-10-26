import { describe, expect, it } from "vitest";
import {
  checksVerdict, httpVerdict, isAuthWall, LEGACY_LOCKFILE_BOT, LOCKFILE_BOT, lockfileChangeProblem, logsVerdict, manifestChangeProblem, type MergeReview, smokePaths, stageLine, unexpectedChange, type WatchInput, watchDue, watchStep,
} from "./pr-watch";

const now = new Date("2026-10-16T10:00:00Z");
const min = (m: number) => new Date(now.getTime() - m * 60_000);
const SHA = "a".repeat(40);
const w = (o: Partial<WatchInput> = {}): WatchInput => ({
  now, openedAt: min(10), pr: { state: "open", merged: false, mergeable: true, headSha: SHA }, recordedSha: SHA, checks: "success",
  preview: { state: "ready", readyAt: min(5) }, smoke: { mode: "http", result: "pass", reason: null }, autoRollbackOn: true, ...o,
});

describe("watchStep", () => {
  it("pending → waits at each stage, then merges when everything is green", () => {
    expect(watchStep(w({ checks: "pending" }))).toEqual({ kind: "wait", stage: "checks", reason: null });
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: null, headSha: SHA } }))).toMatchObject({ kind: "wait", stage: "checks" });
    expect(watchStep(w({ preview: { state: "building", readyAt: null }, smoke: null }))).toEqual({ kind: "wait", stage: "preview", reason: null });
    expect(watchStep(w({ smoke: { mode: "logs", result: "wait", reason: null } }))).toEqual({ kind: "wait", stage: "smoke", reason: null });
    expect(watchStep(w())).toEqual({ kind: "merge" });
  });
  it("fail: CI, a conflict, a failed preview, a failed smoke test", () => {
    expect(watchStep(w({ checks: "failure" }))).toEqual({ kind: "stop", stage: "failed", reason: "CI failed" });
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: false, headSha: SHA } }))).toMatchObject({ kind: "stop", reason: "conflicts with the main branch" });
    expect(watchStep(w({ preview: { state: "error", readyAt: null } }))).toMatchObject({ kind: "stop", reason: "Vercel preview failed" });
    // 1.2.3: a project whose Ignored Build Step skips previews cancels the preview; say so instead of "failed".
    expect(watchStep(w({ preview: { state: "canceled", readyAt: null } }))).toEqual({
      kind: "stop", stage: "failed",
      reason: "Vercel canceled the preview (an Ignored Build Step that skips previews does this), so the update wasn't smoke-tested; check it and merge by hand",
    });
    expect(watchStep(w({ smoke: { mode: "http", result: "fail", reason: "/ answered 500" } }))).toEqual({ kind: "stop", stage: "failed", reason: "preview smoke test failed: / answered 500" });
  });
  // Fix round 1 (review minor 3): GitHub retargets a PR when its base branch is deleted; the watcher never merges then.
  it("stops with needs a look when the PR's base isn't the recorded one; an unchanged base merges", () => {
    const pr = { state: "open" as const, merged: false, mergeable: true, headSha: SHA };
    expect(watchStep(w({ pr: { ...pr, base: "main" }, recordedBase: "web-revamp" }))).toEqual({ kind: "stop", stage: "failed", reason: "the PR's base changed to main" });
    expect(watchStep(w({ pr: { ...pr, base: "web-revamp" }, recordedBase: "web-revamp" }))).toEqual({ kind: "merge" });
    expect(stageLine(12, "failed", "the PR's base changed to main")).toBe("PR #12: needs a look ⚠️ — the PR's base changed to main");
  });
  it("timeout after 45 minutes while still waiting", () => {
    expect(watchStep(w({ openedAt: min(46), checks: "pending" }))).toMatchObject({ kind: "stop", stage: "timeout" });
    expect(watchStep(w({ openedAt: min(46), preview: { state: "building", readyAt: null }, smoke: null }))).toMatchObject({ kind: "stop", stage: "timeout" });
    expect(watchStep(w({ openedAt: min(44), checks: "pending" }))).toMatchObject({ kind: "wait" });
    expect(watchStep(w({ openedAt: min(90) }))).toEqual({ kind: "merge" });
  });
  it("sha changed: the checks start again on the new commit", () => {
    const next = "b".repeat(40);
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: true, headSha: next } }))).toEqual({ kind: "wait", stage: "checks", reason: "new commit on the PR branch, checking again", resetSha: next });
  });
  it("auto-rollback off: stops ready for a manual merge", () => {
    expect(watchStep(w({ autoRollbackOn: false }))).toEqual({ kind: "stop", stage: "ready-manual", reason: "PR is ready to merge, but auto-rollback is off; merge it manually" });
  });
  it("merged or closed by someone: done", () => {
    expect(watchStep(w({ pr: { state: "closed", merged: true, mergeable: null, headSha: SHA } }))).toEqual({ kind: "done", stage: "merged" });
    expect(watchStep(w({ pr: { state: "closed", merged: false, mergeable: null, headSha: SHA } }))).toEqual({ kind: "done", stage: "closed" });
  });
});

describe("checksVerdict", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });
  it("neutral and skipped count as ok; anything running waits; any failure fails", () => {
    expect(checksVerdict({ checkRuns: [run("completed", "success"), run("completed", "neutral"), run("completed", "skipped")], combined: { state: "success", total: 1 }, actionRuns: null })).toBe("success");
    expect(checksVerdict({ checkRuns: [run("in_progress", null)], combined: null, actionRuns: null })).toBe("pending");
    expect(checksVerdict({ checkRuns: [run("completed", "failure"), run("queued", null)], combined: null, actionRuns: null })).toBe("failure");
    expect(checksVerdict({ checkRuns: [], combined: { state: "failure", total: 2 }, actionRuns: null })).toBe("failure");
  });
  it("a commit without any statuses isn't pending; unreadable checks fall back to Actions runs", () => {
    expect(checksVerdict({ checkRuns: [], combined: { state: "pending", total: 0 }, actionRuns: null })).toBe("success");
    expect(checksVerdict({ checkRuns: null, combined: null, actionRuns: [run("completed", "timed_out")] })).toBe("failure");
    expect(checksVerdict({ checkRuns: null, combined: null, actionRuns: null })).toBe("success");
  });
});

describe("smoke modes", () => {
  const h = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  it("HTTP: every path 200–399 passes; a 5xx or no answer fails", () => {
    expect(httpVerdict([{ path: "/", status: 200, ms: 300, authWall: false }, { path: "/api/health", status: 307, ms: 90, authWall: false }])).toEqual({ mode: "http", result: "pass", reason: null });
    expect(httpVerdict([{ path: "/", status: 500, ms: 300, authWall: false }])).toEqual({ mode: "http", result: "fail", reason: "/ answered 500" });
    expect(httpVerdict([{ path: "/x", status: null, ms: 15000, authWall: false }])?.reason).toBe("/x didn't answer within 15 seconds");
  });
  it("behind Vercel Authentication the HTTP part is skipped and the logs decide", () => {
    expect(isAuthWall(401, "<title>Authentication Required</title> vercel.com/sso", h())).toBe(true);
    expect(isAuthWall(403, "", h({ "set-cookie": "_vercel_sso_nonce=x" }))).toBe(true);
    expect(isAuthWall(500, "Authentication Required", h())).toBe(false);
    expect(httpVerdict([{ path: "/", status: 401, ms: 50, authWall: true }])).toBeNull();
    expect(logsVerdict(min(2), now, 0)).toEqual({ mode: "logs", result: "wait", reason: null });
    expect(logsVerdict(min(4), now, 0)).toEqual({ mode: "logs", result: "pass", reason: null });
    expect(logsVerdict(min(4), now, 2)).toEqual({ mode: "logs", result: "fail", reason: "2 errors in the preview logs" });
    expect(logsVerdict(min(4), now, null).result).toBe("wait");
  });
  it("probes / and up to 3 monitor paths", () => {
    expect(smokePaths(["https://a.example/api/health?x=1", "https://a.example/", "https://a.example/login", "https://a.example/a", "https://a.example/b", "nope"])).toEqual(["/", "/api/health", "/login", "/a"]);
  });
});

describe("throttle and text", () => {
  it("every 2 minutes", () => {
    const even = new Date("2026-10-16T10:02:10Z");
    expect(watchDue(even, null)).toBe(true);
    expect(watchDue(new Date("2026-10-16T10:03:10Z"), null)).toBe(false);
    expect(watchDue(new Date("2026-10-16T10:03:10Z"), even.getTime())).toBe(false);
    expect(watchDue(new Date("2026-10-16T10:04:05Z"), even.getTime())).toBe(true);
  });
  it("stage lines", () => {
    expect(stageLine(12, "preview")).toBe("PR #12: waiting for preview");
    expect(stageLine(12, "merged")).toBe("PR #12: merged ✅");
    expect(stageLine(12, "failed", "CI failed")).toBe("PR #12: needs a look ⚠️ — CI failed");
  });
});

// Watchbell 1.2.1 (audit M1): the merge only goes ahead when the PR changes exactly the bumped package.json and its
// lockfile, and every commit is the PR-write token's own or the Actions lockfile commit (lockfile only).
describe("unexpectedChange (the auto-merge allow-list)", () => {
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  const own = { sha: C1, login: "owner-bot", name: "Owner", email: "o@example.com", message: "Watchbell: update next", files: null };
  const bot = { sha: C2, login: null, name: LOCKFILE_BOT.name, email: LOCKFILE_BOT.email, message: LOCKFILE_BOT.message, files: ["apps/web/package-lock.json"] };
  const r = (o: Partial<MergeReview> = {}): MergeReview => ({
    manifest: "apps/web/package.json", lockfile: "apps/web/package-lock.json", tokenLogin: "owner-bot",
    files: [{ filename: "apps/web/package.json" }, { filename: "apps/web/package-lock.json" }], commits: [own, bot], ...o,
  });

  it("allows package.json + lockfile written by the token's user and the Actions lockfile commit", () => {
    expect(unexpectedChange(r())).toBeNull();
    expect(unexpectedChange(r({ commits: [own, { ...own, sha: C2, message: "chore(deps): update package-lock.json (Watchbell runner)" }] }))).toBeNull();
    expect(unexpectedChange(r({ files: [{ filename: "apps/web/package.json" }], commits: [own] }))).toBeNull(); // lockfile not in yet
  });

  it("refuses any other file, a rename into the allowed names, or a PR that doesn't change package.json", () => {
    expect(unexpectedChange(r({ files: [{ filename: "apps/web/package.json" }, { filename: "apps/web/src/app/page.tsx" }] }))).toBe("unexpected change in apps/web/src/app/page.tsx");
    expect(unexpectedChange(r({ files: [{ filename: "package.json" }, { filename: "apps/web/package-lock.json" }] }))).toBe("unexpected change in package.json");
    expect(unexpectedChange(r({ files: [{ filename: "apps/web/package.json" }, { filename: "apps/web/package-lock.json", previous: "scripts/x.js" }] }))).toBe("unexpected change in scripts/x.js");
    expect(unexpectedChange(r({ files: [{ filename: "apps/web/package-lock.json" }] }))).toBe("unexpected change: apps/web/package.json isn't changed");
    expect(unexpectedChange(r({ lockfile: null, files: [{ filename: "apps/web/package.json" }, { filename: "apps/web/package-lock.json" }] }))).toBe("unexpected change in apps/web/package-lock.json");
  });

  it("accepts the lockfile commit of the pre-rename workflow (watchpost[bot]), and nothing else under that name", () => {
    const legacy = { ...bot, name: LEGACY_LOCKFILE_BOT.name, email: LEGACY_LOCKFILE_BOT.email, message: LEGACY_LOCKFILE_BOT.message };
    expect(unexpectedChange(r({ commits: [own, legacy] }))).toBeNull();
    expect(unexpectedChange(r({ commits: [own, { ...legacy, message: LOCKFILE_BOT.message }] }))).toBe("unexpected commit 2222222 by watchpost[bot]");
    expect(unexpectedChange(r({ commits: [own, { ...legacy, files: ["apps/web/package-lock.json", "apps/web/package.json"] }] }))).toBe("unexpected change in apps/web/package.json by commit 2222222");
  });

  it("refuses commits by anyone else, a bot commit touching more than the lockfile, or an unknown token user", () => {
    expect(unexpectedChange(r({ commits: [own, { ...own, sha: C2, login: "mallory" }] }))).toBe("unexpected commit 2222222 by mallory");
    expect(unexpectedChange(r({ commits: [own, { ...bot, files: ["apps/web/package-lock.json", "apps/web/package.json"] }] }))).toBe("unexpected change in apps/web/package.json by commit 2222222");
    expect(unexpectedChange(r({ commits: [own, { ...bot, files: null }] }))).toBe("unexpected commit 2222222 by watchbell[bot]");
    expect(unexpectedChange(r({ commits: [own, { ...bot, message: "chore: tweak" }] }))).toBe("unexpected commit 2222222 by watchbell[bot]");
    expect(unexpectedChange(r({ tokenLogin: null }))).toBe("couldn't confirm who wrote the PR's commits");
    expect(unexpectedChange(r({ headSha: C2 }))).toBeNull();
    expect(unexpectedChange(r({ headSha: C1 }))).toBe("the PR's head moved while it was checked");
    expect(unexpectedChange(r({ commits: [] }))).toBe("couldn't confirm who wrote the PR's commits");
  });

  it("refuses with the lockfile's content problem (review T2b-fix I-1)", () => {
    expect(unexpectedChange(r({ lockfileProblem: "unexpected lockfile change next" }))).toBe("unexpected lockfile change next");
    expect(unexpectedChange(r({ lockfileProblem: null }))).toBeNull();
  });
});

// Review I4: package.json may change only in the bumped packages' version strings.
describe("manifestChangeProblem", () => {
  const base = JSON.stringify({ name: "a", scripts: { build: "next build" }, dependencies: { next: "15.0.3", react: "19.0.0" }, devDependencies: { eslint: "9.0.0" } });
  const head = (o: object) => JSON.stringify({ ...JSON.parse(base), ...o });
  it("allows only the bumped versions as plain ranges", () => {
    expect(manifestChangeProblem(base, head({ dependencies: { next: "^15.0.5", react: "19.0.0" } }), ["next"])).toBeNull();
    expect(manifestChangeProblem(base, base, ["next"])).toBeNull();
  });
  it("refuses scripts, other dependencies, overrides, odd specifiers and added packages", () => {
    expect(manifestChangeProblem(base, head({ scripts: { build: "next build", postinstall: "curl x | sh" } }), ["next"])).toMatch(/beyond the bumped/);
    expect(manifestChangeProblem(base, head({ dependencies: { next: "15.0.5", react: "19.0.1" } }), ["next"])).toMatch(/beyond the bumped/);
    expect(manifestChangeProblem(base, head({ overrides: { x: "1" } }), ["next"])).toMatch(/beyond the bumped/);
    expect(manifestChangeProblem(base, head({ dependencies: { next: "github:evil/next", react: "19.0.0" } }), ["next"])).toMatch(/plain version/);
    expect(manifestChangeProblem(base, head({ dependencies: { next: "npm:evil@1", react: "19.0.0" } }), ["next"])).toMatch(/plain version/);
    expect(manifestChangeProblem(base, head({ devDependencies: { eslint: "9.0.0", next: "15.0.5" } }), ["next"])).toMatch(/added or removed/);
    expect(manifestChangeProblem(base, "{", ["next"])).toMatch(/JSON/);
  });
});

// Review T2b-fix I-1: the lockfile's new or changed packages must come from the base lockfile's registry, in the
// registry's own tarball form, with a sha512 integrity; no links, git, file, github: or plain http sources.
describe("lockfileChangeProblem", () => {
  const SRI = (c: string) => `sha512-${c.repeat(86)}==`;
  const reg = (name: string, version: string, origin = "https://registry.npmjs.org") =>
    `${origin}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
  const entry = (name: string, version: string, o: object = {}) => ({ version, resolved: reg(name, version), integrity: SRI("a"), ...o });
  const lock = (packages: Record<string, unknown>, o: object = {}) =>
    JSON.stringify({ name: "web", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "web", dependencies: { next: "15.0.3" } }, ...packages }, ...o });
  const base = lock({
    "node_modules/next": entry("next", "15.0.3"),
    "node_modules/@next/env": entry("@next/env", "15.0.3"),
    "node_modules/react": entry("react", "19.0.0", { peer: true }),
  });
  const bumped = (o: Record<string, unknown> = {}) => lock({
    "": { name: "web", dependencies: { next: "^15.0.5" } },
    "node_modules/next": entry("next", "15.0.5", { dependencies: { "@next/env": "15.0.5" } }),
    "node_modules/@next/env": entry("@next/env", "15.0.5", { integrity: SRI("b") }),
    "node_modules/react": entry("react", "19.0.0"),
    "node_modules/next/node_modules/busboy": entry("busboy", "1.6.0"),
    ...o,
  });
  const P = "apps/web/package-lock.json";

  it("a normal bump passes: new versions, a new nested package, a flag change, a removed package", () => {
    expect(lockfileChangeProblem(base, bumped(), P)).toBeNull();
    expect(lockfileChangeProblem(base, base, P)).toBeNull();
    expect(lockfileChangeProblem(base, bumped({ "node_modules/react": undefined }), P)).toBeNull();
    // No lockfile at the base yet: npm's registry is the only one allowed.
    expect(lockfileChangeProblem(null, bumped(), P)).toBeNull();
  });

  it("keeps the base lockfile's own registry (a mirror with a path prefix too)", () => {
    const m = "https://npm.example.com/repo/npm";
    const mb = lock({ "node_modules/next": entry("next", "15.0.3", { resolved: reg("next", "15.0.3", m) }) });
    expect(lockfileChangeProblem(mb, lock({ "node_modules/next": entry("next", "15.0.5", { resolved: reg("next", "15.0.5", m) }) }), P)).toBeNull();
    expect(lockfileChangeProblem(mb, lock({ "node_modules/next": entry("next", "15.0.5", { resolved: reg("next", "15.0.5", "https://registry.npmjs.org") }) }), P))
      .toBe("unexpected lockfile change next");
  });

  it("refuses a resolved URL off the registry or not in the tarball form", () => {
    const bad = (resolved: string, name = "next") => lockfileChangeProblem(base, bumped({ [`node_modules/${name}`]: entry(name, "15.0.5", { resolved }) }), P);
    expect(bad("https://attacker.example/next/-/next-15.0.5.tgz")).toBe("unexpected lockfile change next");
    expect(bad("https://registry.npmjs.org/next/-/evil-15.0.5.tgz")).toBe("unexpected lockfile change next");
    expect(bad("https://registry.npmjs.org/evil/-/next-15.0.5.tgz")).toBe("unexpected lockfile change next");
    expect(bad("https://registry.npmjs.org/next/-/next-15.0.4.tgz")).toBe("unexpected lockfile change next");
    expect(bad("https://registry.npmjs.org/next/-/next-15.0.5.tgz?x=1")).toBe("unexpected lockfile change next");
    expect(bad("https://user@registry.npmjs.org/next/-/next-15.0.5.tgz")).toBe("unexpected lockfile change next");
    expect(bad("https://registry.npmjs.org/@next/env/-/x-15.0.5.tgz", "@next/env")).toBe("unexpected lockfile change @next/env");
  });

  it("refuses git+, file:, github: and http: sources and links", () => {
    for (const resolved of ["git+ssh://git@github.com/evil/next.git#abc", "file:../evil.tgz", "github:evil/next", "http://registry.npmjs.org/next/-/next-15.0.5.tgz"]) {
      expect(lockfileChangeProblem(base, bumped({ "node_modules/next": entry("next", "15.0.5", { resolved }) }), P)).toBe("unexpected lockfile change next");
    }
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": entry("next", "15.0.5", { link: true }) }), P)).toBe("unexpected lockfile change next");
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": { resolved: "../evil", link: true } }), P)).toBe("unexpected lockfile change next");
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": entry("next", "git+ssh://git@github.com/evil/next.git") }), P)).toBe("unexpected lockfile change next");
  });

  it("refuses a missing or weak integrity", () => {
    const noIntegrity: Record<string, unknown> = entry("next", "15.0.5");
    delete noIntegrity.integrity;
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": noIntegrity }), P)).toBe("unexpected lockfile change next");
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": entry("next", "15.0.5", { integrity: "sha1-abc=" }) }), P)).toBe("unexpected lockfile change next");
  });

  it("refuses a changed lockfileVersion, a removed or unreadable lockfile", () => {
    expect(lockfileChangeProblem(base, bumped().replace('"lockfileVersion":3', '"lockfileVersion":2'), P)).toBe("unexpected lockfile change lockfileVersion");
    expect(lockfileChangeProblem(base, null, P)).toBe(`unexpected lockfile change ${P}`);
    expect(lockfileChangeProblem(base, "{", P)).toBe(`unexpected lockfile change ${P}`);
    expect(lockfileChangeProblem(base, JSON.stringify({ lockfileVersion: 3 }), P)).toBe(`unexpected lockfile change ${P}`);
  });

  it("refuses an alias to another package, a key outside node_modules, and new metadata under an unchanged version", () => {
    expect(lockfileChangeProblem(base, bumped({ "node_modules/next": { ...entry("evil-next", "1.0.0"), name: "evil-next" } }), P)).toBe("unexpected lockfile change next");
    expect(lockfileChangeProblem(base, bumped({ "node_modules/../../evil": entry("evil", "1.0.0") }), P)).toBe("unexpected lockfile change node_modules/../../evil");
    expect(lockfileChangeProblem(base, bumped({ "tools/evil": { name: "evil", version: "1.0.0" } }), P)).toBe("unexpected lockfile change tools/evil");
    // react stays 19.0.0, but now "depends on" an attacker's package: that never happens in a real bump.
    expect(lockfileChangeProblem(base, bumped({ "node_modules/react": entry("react", "19.0.0", { dependencies: { "evil-pkg": "1.0.0" } }) }), P))
      .toBe("unexpected lockfile change react");
    expect(lockfileChangeProblem(base, bumped({ "": { name: "web", resolved: "https://attacker.example/x.tgz" } }), P)).toBe("unexpected lockfile change web");
  });

  // Review T2b-fix3 m-1: "__proto__" in the head isn't the base's Object.prototype, so it's a new folder (refused).
  it("refuses a new __proto__ folder entry (only the base's own keys count)", () => {
    const head = bumped().replace('"packages":{', '"packages":{"__proto__":{"name":"evil","version":"1.0.0"},');
    expect(Object.keys(JSON.parse(head).packages)).toContain("__proto__");
    expect(lockfileChangeProblem(base, head, P)).toBe("unexpected lockfile change __proto__");
    expect(lockfileChangeProblem(null, head, P)).toBe("unexpected lockfile change __proto__");
    const nm = bumped().replace('"packages":{', '"packages":{"node_modules/__proto__":{"version":"1.0.0"},');
    expect(lockfileChangeProblem(base, nm, P)).not.toBeNull();
  });

  // Review T2b-fix3 m-2: npm 6 reads only the legacy `dependencies` tree, which isn't checked; v2 and v3 have `packages`.
  it("requires lockfileVersion 2 or 3 on the head, with or without a base lockfile", () => {
    const v = (version: unknown) => bumped().replace('"lockfileVersion":3', `"lockfileVersion":${JSON.stringify(version)}`);
    const baseV = (version: unknown) => base.replace('"lockfileVersion":3', `"lockfileVersion":${JSON.stringify(version)}`);
    for (const bad of [1, "3", null, 4, 2.5]) {
      expect(lockfileChangeProblem(null, v(bad), P)).toBe("unexpected lockfile change lockfileVersion");
      expect(lockfileChangeProblem(baseV(bad), v(bad), P)).toBe("unexpected lockfile change lockfileVersion");
    }
    expect(lockfileChangeProblem(null, bumped().replace('"lockfileVersion":3,', ""), P)).toBe("unexpected lockfile change lockfileVersion");
    expect(lockfileChangeProblem(null, v(2), P)).toBeNull();
    expect(lockfileChangeProblem(baseV(2), v(2), P)).toBeNull();
    expect(lockfileChangeProblem(base, bumped(), P)).toBeNull();
  });

  // Review T2b-fix3 m-3: a huge or pathological lockfile stops the PR (a refusal), never "couldn't be read" forever.
  it("refuses a lockfile over 25 MB without parsing it", () => {
    const cap = 25 * 1024 * 1024;
    const pad = (t: string, bytes: number) => t.replace(/}$/, " ".repeat(bytes - t.length) + "}");
    expect(lockfileChangeProblem(base, pad(bumped(), cap), P)).toBeNull();
    expect(lockfileChangeProblem(base, pad(bumped(), cap + 1), P)).toBe(`lockfile too large to check (over 25 MB): ${P}`);
    expect(lockfileChangeProblem(pad(base, cap + 1), bumped(), P)).toBe(`lockfile too large to check (over 25 MB): ${P}`);
    // Counted in UTF-8 bytes: 9 MB of three-byte characters is 27 MB.
    const wide = bumped().replace('"name":"web"', `"name":"web","x":"${"€".repeat(9 * 1024 * 1024)}"`);
    expect(wide.length).toBeLessThan(cap);
    expect(lockfileChangeProblem(base, wide, P)).toBe(`lockfile too large to check (over 25 MB): ${P}`);
  });

  it("refuses a lockfile it can't check (a value nested too deep to compare) instead of throwing", () => {
    const deep = `${"{\"a\":".repeat(200_000)}1${"}".repeat(200_000)}`;
    const head = bumped().replace(/"node_modules\/react":\{[^}]*\}/, `"node_modules/react":${deep}`);
    expect(() => JSON.parse(head)).not.toThrow();
    expect(lockfileChangeProblem(base, head, P)).toBe(`unexpected lockfile change ${P} (couldn't be checked)`);
  });
});
