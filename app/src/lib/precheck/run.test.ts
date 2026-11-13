import { describe, expect, it } from "vitest";
import { addedSourceLines, postComment, type RunIo, runPrecheck, scannedReport } from "./run";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const lock = (deps: Record<string, string>) => JSON.stringify({
  lockfileVersion: 3,
  packages: { "": { name: "app" }, ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }])) },
});

function io(o: { files?: Record<string, string>; batch?: (body: { queries: { package: { name: string } }[] }) => unknown; vulns?: Record<string, unknown>; gitleaks?: string | null; lines?: string[] } = {}): RunIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    show: async (ref, path) => o.files?.[`${ref === BASE ? "base" : "head"}:${path}`] ?? null,
    addedLines: async () => o.lines ?? [],
    osvBatch: async (body) => {
      const b = body as { queries: { package: { name: string }; version: string }[] };
      asked.push(...b.queries.map((q) => `${q.package.name}@${q.version}`));
      return o.batch ? o.batch(b) : { results: b.queries.map(() => ({})) };
    },
    osvVuln: async (id) => o.vulns?.[id] ?? null,
    gitleaksReport: async () => (o.gitleaks === undefined ? "[]" : o.gitleaks),
  };
}

describe("runPrecheck", () => {
  it("says there is no lockfile, and still checks secrets and env names", async () => {
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, io({ files: { "head:.env.example": "A=" } }));
    expect(r.packages).toEqual({ ok: false, reason: "No lockfile in the repository root." });
    expect(r.secrets).toEqual({ ok: true, items: [] });
    expect(r.env).toEqual({ ok: true, items: { example: ["A"], code: [] } });
  });
  it("names the folder when the app lives in one", async () => {
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "apps/web" }, io());
    expect(r.packages).toEqual({ ok: false, reason: "No lockfile in apps/web." });
  });
  it("asks OSV.dev only about the packages the pull request adds or changes", async () => {
    const x = io({ files: { "base:package-lock.json": lock({ a: "1.0.0", next: "16.4.2" }), "head:package-lock.json": lock({ a: "1.0.0", next: "16.4.3", b: "2.0.0" }) } });
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, x);
    expect(x.asked.sort()).toEqual(["b@2.0.0", "next@16.4.3"]);
    expect(r.next).toEqual({ from: "16.4.2", to: "16.4.3" });
    expect(r.packages).toEqual({ ok: true, items: [] });
  });
  it("asks about every package when only the head has a lockfile", async () => {
    const x = io({ files: { "head:package-lock.json": lock({ a: "1.0.0", b: "2.0.0" }) } });
    await runPrecheck({ base: BASE, head: HEAD, dir: "." }, x);
    expect(x.asked.sort()).toEqual(["a@1.0.0", "b@2.0.0"]);
  });
  it("turns an advisory into a finding", async () => {
    const x = io({
      files: { "head:package-lock.json": lock({ a: "1.0.0" }) },
      batch: () => ({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }] }] }),
      vulns: { "GHSA-aaaa-bbbb-cccc": { id: "GHSA-aaaa-bbbb-cccc", summary: "bad", database_specific: { severity: "HIGH" }, affected: [{ package: { name: "a", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] } },
    });
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, x);
    expect(r.packages.ok && r.packages.items.map((v) => [v.package, v.vulnId, v.severity, v.fixedVersion])).toEqual([["a", "GHSA-aaaa-bbbb-cccc", "high", "1.0.1"]]);
  });
  it("keeps going when OSV.dev fails", async () => {
    const x = io({ files: { "head:package-lock.json": lock({ a: "1.0.0" }) }, batch: () => { throw new Error("down"); }, lines: ["process.env.NEW_KEY"] });
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, x);
    expect(r.packages).toEqual({ ok: false, reason: "OSV.dev couldn't be asked (down)." });
    expect(r.env).toEqual({ ok: true, items: { example: [], code: ["NEW_KEY"] } });
  });
  it("says so when gitleaks didn't run", async () => {
    const r = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, io({ gitleaks: null }));
    expect(r.secrets).toEqual({ ok: false, reason: "gitleaks didn't run." });
  });
});

describe("addedSourceLines", () => {
  it("keeps added lines of source files, not tests or other files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1,2 @@", "+const k = process.env.KEY;", "-old",
      "diff --git a/src/a.test.ts b/src/a.test.ts", "--- a/src/a.test.ts", "+++ b/src/a.test.ts", "+process.env.TEST_ONLY",
      "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "+process.env.DOCS",
      "diff --git a/x.mjs b/x.mjs", "--- /dev/null", "+++ b/x.mjs", "+process.env.MJS",
    ].join("\n");
    expect(addedSourceLines(diff)).toEqual(["const k = process.env.KEY;", "process.env.MJS"]);
  });
});

describe("postComment", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const marker = '<!-- watchbell-precheck {"v":1} -->\nold';
  it("edits the bot's marker comment", async () => {
    const calls: [string, string][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      if ((init?.method ?? "GET") === "GET") return ok([{ id: 7, body: marker, user: { login: "someone" } }, { id: 9, body: marker, user: { login: "github-actions[bot]" } }]);
      return ok({});
    }) as typeof fetch;
    expect(await postComment({ repo: "o/r", pr: 3, token: "t", body: "new" }, f)).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["PATCH", "https://api.github.com/repos/o/r/issues/comments/9"]);
  });
  it("adds a comment when there is none", async () => {
    const calls: [string, string][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      return ok(init?.method ? {} : []);
    }) as typeof fetch;
    expect(await postComment({ repo: "o/r", pr: 3, token: "t", body: "new" }, f)).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["POST", "https://api.github.com/repos/o/r/issues/3/comments"]);
  });
  it("answers an error instead of throwing on a read-only token (fork)", async () => {
    const f = (async (_url: string, init?: RequestInit) => (init?.method ? new Response("{}", { status: 403 }) : ok([]))) as typeof fetch;
    expect(await postComment({ repo: "o/r", pr: 3, token: "t", body: "new" }, f)).toEqual({ ok: false, error: "GitHub answered HTTP 403 to the comment." });
  });
  it("refuses a repository or number that isn't one", async () => {
    const f = (async () => ok([])) as typeof fetch;
    expect((await postComment({ repo: "o/../r", pr: 3, token: "t", body: "x" }, f)).ok).toBe(false);
    expect((await postComment({ repo: "o/r", pr: 0, token: "t", body: "x" }, f)).ok).toBe(false);
  });
});

describe("scannedReport", () => {
  it("reads gitleaks' report only after a scan that succeeded", async () => {
    const read = async () => "[]";
    expect(await scannedReport("success", read)).toBe("[]");
    expect(await scannedReport("failure", read)).toBeNull();
    expect(await scannedReport("skipped", read)).toBeNull();
    expect(await scannedReport(undefined, read)).toBeNull();
  });
});

describe("review minors (1.4)", () => {
  it("notes a base lockfile that is missing or can't be read", async () => {
    const head = lock({ a: "1.0.0" });
    const missing = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, io({ files: { "head:package-lock.json": head } }));
    expect(missing.baseNote).toBe("The base branch has no package-lock.json, so every package counts as new.");
    const broken = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, io({ files: { "head:package-lock.json": head, "base:package-lock.json": "{not json" } }));
    expect(broken.baseNote).toBe("The base branch's package-lock.json couldn't be read, so every package counts as new.");
    const fine = await runPrecheck({ base: BASE, head: HEAD, dir: "." }, io({ files: { "head:package-lock.json": head, "base:package-lock.json": head } }));
    expect(fine.baseNote).toBeNull();
  });
  it("reads quoted paths and added lines that start with ++", () => {
    const diff = [
      'diff --git "a/sp ace.ts" "b/sp ace.ts"', '--- "a/sp ace.ts"', '+++ "b/sp ace.ts"', "@@ -0,0 +1 @@", "+process.env.QUOTED",
      "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -0,0 +2 @@", "+++ process.env.PLUS", "+process.env.AFTER",
    ].join("\n");
    expect(addedSourceLines(diff)).toEqual(["process.env.QUOTED", "++ process.env.PLUS", "process.env.AFTER"]);
  });
});
