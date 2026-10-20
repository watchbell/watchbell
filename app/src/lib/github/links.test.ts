import { describe, expect, it } from "vitest";
import type { GhRepo } from "@/lib/providers/github";
import { autoLinks, packageCandidates, planRepos, suggestRepo } from "./links";

const gh = (id: string, fullName: string): GhRepo => ({
  id, owner: fullName.split("/")[0], name: fullName.split("/")[1], fullName, defaultBranch: "main", private: true, archived: false, htmlUrl: null, pushedAt: null,
});
const d = (iso: string) => new Date(iso);

describe("planRepos", () => {
  it("inserts new ids, updates known ones (a rename keeps the row) and marks vanished ones gone once", () => {
    const plan = planRepos(
      [{ id: "r1", externalId: "1", goneAt: null }, { id: "r2", externalId: "2", goneAt: null }, { id: "r3", externalId: "3", goneAt: d("2026-10-01") }],
      [gh("1", "acme/renamed"), gh("4", "acme/new")],
    );
    expect(plan.insert.map((r) => r.id)).toEqual(["4"]);
    expect(plan.update).toEqual([{ id: "r1", repo: gh("1", "acme/renamed") }]);
    expect(plan.gone).toEqual(["r2"]);
  });
});

describe("autoLinks (Vercel's link.repo)", () => {
  const repos = [{ id: "r1", fullName: "Acme/Acme-Shop", goneAt: null }, { id: "r2", fullName: "acme/other", goneAt: null }, { id: "r9", fullName: "acme/gone", goneAt: d("2026-10-01") }];
  it("links an app to the repository its Vercel project names, case-insensitively", () => {
    expect(autoLinks([{ id: "a1", name: "acme-shop", repo: "acme/acme-shop", repoType: "github" }], repos, [])).toEqual([{ appId: "a1", repoId: "r1" }]);
  });
  it("never overrides the owner's choice, never rewrites a right link, skips other git hosts and gone repositories", () => {
    const apps = [
      { id: "a1", name: "x", repo: "acme/acme-shop", repoType: "github" },
      { id: "a2", name: "y", repo: "acme/other", repoType: "github" },
      { id: "a3", name: "z", repo: "acme/other", repoType: "gitlab" },
      { id: "a4", name: "w", repo: "acme/gone", repoType: "github" },
      { id: "a5", name: "v", repo: "acme/other", repoType: "github" },
    ];
    const links = [{ appId: "a1", repoId: "r2", source: "manual" as const }, { appId: "a2", repoId: "r2", source: "vercel" as const }, { appId: "a5", repoId: "r1", source: "vercel" as const }];
    expect(autoLinks(apps, repos, links)).toEqual([{ appId: "a5", repoId: "r2" }]);
  });
});

describe("suggestRepo", () => {
  const base = { packageName: null, archived: false, goneAt: null, pushedAt: null };
  it("suggests the same name first, then the same package.json name (scope dropped)", () => {
    expect(suggestRepo("Acme-Shop", [{ ...base, id: "r1", name: "acme-shop" }])).toEqual({ repoId: "r1", why: "name" });
    expect(suggestRepo("portfolio-site", [{ ...base, id: "r2", name: "portfolio", packageName: "@acme/portfolio-site" }])).toEqual({ repoId: "r2", why: "package" });
    expect(suggestRepo("nothing", [{ ...base, id: "r1", name: "acme-shop" }])).toBeNull();
  });
  it("never suggests an archived or gone repository, and prefers the newest push", () => {
    expect(suggestRepo("app", [{ ...base, id: "r1", name: "app", archived: true }, { ...base, id: "r2", name: "app", goneAt: d("2026-10-01") }])).toBeNull();
    expect(suggestRepo("app", [{ ...base, id: "old", name: "app", pushedAt: d("2025-01-01") }, { ...base, id: "new", name: "App", pushedAt: d("2026-10-01") }])).toEqual({ repoId: "new", why: "name" });
  });
});

describe("packageCandidates", () => {
  it("reads unread or pushed-since repositories, newest first, ten at most", () => {
    const repos = [
      { id: "fresh", archived: false, goneAt: null, pushedAt: d("2026-10-10"), packageCheckedAt: d("2026-10-11") },
      { id: "pushed", archived: false, goneAt: null, pushedAt: d("2026-10-12"), packageCheckedAt: d("2026-10-11") },
      { id: "never", archived: false, goneAt: null, pushedAt: d("2026-09-01"), packageCheckedAt: null },
      { id: "archived", archived: true, goneAt: null, pushedAt: null, packageCheckedAt: null },
    ];
    expect(packageCandidates(repos).map((r) => r.id)).toEqual(["pushed", "never"]);
    const many = Array.from({ length: 15 }, (_, i) => ({ id: String(i), archived: false, goneAt: null, pushedAt: d(`2026-10-${String(i + 1).padStart(2, "0")}`), packageCheckedAt: null }));
    expect(packageCandidates(many).map((r) => r.id)).toEqual(["14", "13", "12", "11", "10", "9", "8", "7", "6", "5"]);
  });
});
