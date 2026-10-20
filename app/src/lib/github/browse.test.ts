import { describe, expect, it } from "vitest";
import { hiddenReason, NEVER_READ } from "@/lib/code/never-read";
import { ancestors, buildTree, countFromLink, filePlan, FILE_VIEW_MAX, filterRepos, linkedAppsByRepo, NO_FILTER, type RepoListItem, sizeText, type TreeNode } from "./browse";

const item = (fullName: string, p: Partial<RepoListItem> = {}): RepoListItem => ({
  id: fullName, fullName, private: true, archived: false, defaultBranch: "main", pushedAt: null, language: null, apps: [], advisories: null, actions: null, ...p,
});

describe("filterRepos", () => {
  const rows = [
    item("me/old", { pushedAt: "2026-01-01T00:00:00Z", private: false }),
    item("me/new", { pushedAt: "2026-10-01T00:00:00Z", apps: [{ id: "a1", name: "portfolio" }] }),
    item("me/never"),
    item("me/mid", { pushedAt: "2026-05-01T00:00:00Z", language: "TypeScript", apps: [{ id: "a2", name: "shop" }] }),
  ];

  it("sorts by last push, newest first, never-pushed last", () => {
    expect(filterRepos(rows, NO_FILTER).map((r) => r.fullName)).toEqual(["me/new", "me/mid", "me/old", "me/never"]);
  });

  it("filters linked / unlinked", () => {
    expect(filterRepos(rows, { ...NO_FILTER, linked: "linked" }).map((r) => r.fullName)).toEqual(["me/new", "me/mid"]);
    expect(filterRepos(rows, { ...NO_FILTER, linked: "unlinked" }).map((r) => r.fullName)).toEqual(["me/old", "me/never"]);
  });

  it("filters private / public", () => {
    expect(filterRepos(rows, { ...NO_FILTER, visibility: "public" }).map((r) => r.fullName)).toEqual(["me/old"]);
    expect(filterRepos(rows, { ...NO_FILTER, visibility: "private" })).toHaveLength(3);
  });

  it("searches the name, case-insensitive, and a linked app's name", () => {
    expect(filterRepos(rows, { ...NO_FILTER, q: "  NEW " }).map((r) => r.fullName)).toEqual(["me/new"]);
    expect(filterRepos(rows, { ...NO_FILTER, q: "shop" }).map((r) => r.fullName)).toEqual(["me/mid"]);
    expect(filterRepos(rows, { ...NO_FILTER, q: "typescript" }).map((r) => r.fullName)).toEqual(["me/mid"]);
  });

  it("combines the filters", () => {
    expect(filterRepos(rows, { q: "me/", linked: "linked", visibility: "public" })).toEqual([]);
  });
});

describe("linkedAppsByRepo", () => {
  it("groups the apps per repository, by name, dropping unknown apps and duplicates", () => {
    const apps = [{ id: "a1", name: "web" }, { id: "a2", name: "api" }, { id: "a3", name: "docs" }];
    const m = linkedAppsByRepo([{ appId: "a1", repoId: "r1" }, { appId: "a2", repoId: "r1" }, { appId: "a3", repoId: "r2" }, { appId: "gone", repoId: "r3" }, { appId: "a1", repoId: "r1" }], apps);
    expect(m.get("r1")).toEqual([{ id: "a2", name: "api" }, { id: "a1", name: "web" }]);
    expect(m.get("r2")).toEqual([{ id: "a3", name: "docs" }]);
    expect(m.has("r3")).toBe(false);
  });
});

describe("the hidden-file rule", () => {
  it.each([
    [".env", "secret"], [".env.local", "secret"], [".env.example", "secret"], ["apps/web/.env.production", "secret"], ["certs/server.pem", "secret"], ["deploy/key.p12", "secret"],
    ["id_rsa", "secret"], ["home/.ssh/id_ed25519.pub", "secret"], ["config/secrets.json", "secret"], ["src/credentials.ts", "secret"], ["tls/site.crt", "secret"],
    ["package-lock.json", "generated"], ["web/pnpm-lock.yaml", "generated"], ["node_modules/x/index.js", "generated"], [".next/server/app.js", "generated"], ["dist/main.js", "generated"],
    ["public/logo.png", "binary"], ["fonts/a.woff2", "binary"],
    ["../etc/passwd", "secret"], ["", "secret"],
  ])("%s → %s", (path, reason) => {
    expect(hiddenReason(path)).toBe(reason);
  });

  it.each(["src/app/page.tsx", "README.md", "package.json", "docs/environment.md", "src/lib/keys.ts"])("%s may be read", (path) => {
    expect(hiddenReason(path)).toBeNull();
  });

  it("is the same list the Dev officer uses", () => {
    for (const p of [".env", "a.pem", "yarn.lock", "x.png"]) expect(NEVER_READ.some((re) => re.test(p))).toBe(true);
  });
});

const names = (n: TreeNode): unknown => (n.kind === "dir" ? { [n.name + "/"]: n.hidden ?? n.children.map(names) } : n.hidden ? `${n.name} (${n.hidden})` : n.name);

describe("buildTree", () => {
  const entries = [
    { path: "src/b.ts", size: 10 }, { path: "README.md", size: 5 }, { path: "src/a/x.ts", size: 1 }, { path: ".env", size: 3 },
    { path: "node_modules/pkg/index.js", size: 9 }, { path: "node_modules/pkg/package.json", size: 9 }, { path: "src/A.ts", size: 2 }, { path: "logo.png", size: 100 },
    { path: "../escape", size: 1 }, { path: "/abs", size: 1 }, { path: "a//b", size: 1 },
  ];

  it("puts folders first, then files by name, and marks hidden ones", () => {
    const { root, files, cut } = buildTree(entries);
    expect(root.children.map(names)).toEqual([
      { "node_modules/": "generated" },
      { "src/": [{ "a/": ["x.ts"] }, "A.ts", "b.ts"] },
      ".env (secret)", "logo.png (binary)", "README.md",
    ]);
    expect(files).toBe(6);
    expect(cut).toBe(false);
  });

  it("never lists the files inside a hidden folder", () => {
    const { root } = buildTree(entries);
    const nm = root.children.find((c) => c.name === "node_modules")!;
    expect(nm.children).toEqual([]);
  });

  it("cuts a very large tree", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, size: 1 }));
    const t = buildTree(many, 20);
    expect(t.files).toBe(20);
    expect(t.cut).toBe(true);
  });

  it("opens the folders above a file", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });
});

describe("filePlan", () => {
  const entries = [{ path: "src/a.ts", size: 100 }, { path: "big.json", size: FILE_VIEW_MAX + 1 }, { path: ".env", size: 10 }, { path: "img.png", size: 10 }];

  it("reads only files in the tree, under the size cap, never hidden ones", () => {
    expect(filePlan("src/a.ts", entries)).toEqual({ kind: "read", size: 100 });
    expect(filePlan("big.json", entries)).toEqual({ kind: "too-big", size: FILE_VIEW_MAX + 1 });
    expect(filePlan(".env", entries)).toEqual({ kind: "hidden", reason: "secret" });
    expect(filePlan("img.png", entries)).toEqual({ kind: "hidden", reason: "binary" });
    expect(filePlan("src/other.ts", entries)).toEqual({ kind: "missing" });
    expect(filePlan("../../etc/passwd", entries)).toEqual({ kind: "hidden", reason: "secret" });
    expect(filePlan("config/.env.local", entries)).toEqual({ kind: "hidden", reason: "secret" });
  });
});

describe("helpers", () => {
  it("counts from GitHub's Link header", () => {
    expect(countFromLink('<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=7>; rel="last"', 1)).toBe(7);
    expect(countFromLink(null, 1)).toBe(1);
    expect(countFromLink(null, 0)).toBe(0);
  });

  it("writes sizes", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(200 * 1024)).toBe("200 KB");
    expect(sizeText(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
