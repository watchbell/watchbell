import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelDeployment, chooseProductionDomain, currentProduction, discoverVercel, domainConfig, getDeployment, listDeployments, listProjectDomains, listProjects,
  mapDeploymentState, productionDeployments, promote, promotePreview, redeploy, rollback, runningProductionBuild, tokenExpiry,
} from "./vercel";

// MSW lets unhandled requests for common assets (.js, .json, .html…) through to the real network even with
// onUnhandledFrame "error". This catch-all, kept by resetHandlers, turns every unmatched request into a network error
// and records it, so these tests can never reach Vercel (stage 6: an unexpected write fails the test).
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const token = "tok_abcdefghijklmnopqrstuvwxyz";
const team = { id: "team_a", slug: "acme-team", name: "Acme' projects" };
const project = (id: string, name: string, current: { id: string; readyState: string } | null = null) => ({
  id, name, framework: "nextjs", createdAt: 1_760_000_000_000, link: { productionBranch: "main" },
  targets: current ? { production: current } : {},
});

describe("mapDeploymentState", () => {
  it.each([["READY", "ready"], ["ERROR", "error"], ["CANCELED", "canceled"], ["BUILDING", "building"], ["QUEUED", "building"], ["INITIALIZING", "building"]])(
    "%s → %s", (raw, state) => expect(mapDeploymentState(raw)).toBe(state),
  );
});

describe("chooseProductionDomain", () => {
  it("prefers a verified custom domain without redirect or branch", () => {
    expect(chooseProductionDomain([
      { name: "web.vercel.app", verified: true },
      { name: "www.example.com", verified: true, redirect: "example.com" },
      { name: "preview.example.com", verified: true, gitBranch: "dev" },
      { name: "example.com", verified: true },
    ], "web")).toBe("example.com");
  });
  it("falls back to the vercel.app domain, then to <name>.vercel.app", () => {
    expect(chooseProductionDomain([{ name: "web-xyz.vercel.app", verified: true }], "web")).toBe("web-xyz.vercel.app");
    expect(chooseProductionDomain([], "web")).toBe("web.vercel.app");
  });
});

describe("chooseProductionDomain: the domain production is served on (1.2.1)", () => {
  it("prefers the domain the others redirect to, then a production alias, over list order", () => {
    // The shopfront move: the old domain redirects to the new one; a demo domain sits first in the list.
    expect(chooseProductionDomain([
      { name: "demo-finance.example.com", verified: true },
      { name: "old-finance.example.net", verified: true, redirect: "finance.example.com" },
      { name: "finance.example.com", verified: true },
    ], "shopfront")).toBe("finance.example.com");
    expect(chooseProductionDomain([
      { name: "demo-finance.example.com", verified: true },
      { name: "finance.example.com", verified: true },
    ], "shopfront", ["shopfront.vercel.app", "finance.example.com"])).toBe("finance.example.com");
  });
  it("skips a custom-environment domain and, among equals, takes the shorter name", () => {
    expect(chooseProductionDomain([
      { name: "a.example.com", verified: true, customEnvironmentId: "env_demo" },
      { name: "demo-web.example.com", verified: true },
      { name: "web.example.com", verified: true },
    ], "web")).toBe("web.example.com");
  });
});

describe("listProjectDomains: every page or nothing (review T3 I1)", () => {
  it("asks for 100 a page and follows pagination.next to the end", async () => {
    const seen: string[] = [];
    server.use(http.get("https://api.vercel.com/v9/projects/p1/domains", ({ request }) => {
      const u = new URL(request.url);
      seen.push(`${u.searchParams.get("limit")}:${u.searchParams.get("until") ?? "-"}`);
      return u.searchParams.get("until")
        ? HttpResponse.json({ domains: [{ name: "example.com", verified: true }], pagination: { next: null } })
        : HttpResponse.json({ domains: [{ name: "pr-1.example.com", verified: true, gitBranch: "pr-1" }], pagination: { next: 1700 } });
    }));
    const r = await listProjectDomains(token, "team_a", "p1");
    expect(seen).toEqual(["100:-", "100:1700"]);
    expect(r.ok && r.data.map((d) => d.name)).toEqual(["pr-1.example.com", "example.com"]);
  });
  it("fails (so the stored domains are kept) when the list doesn't end within the page budget", async () => {
    server.use(http.get("https://api.vercel.com/v9/projects/p1/domains", ({ request }) =>
      HttpResponse.json({ domains: [{ name: `d${new URL(request.url).searchParams.get("until") ?? 0}.example.com` }], pagination: { next: Number(new URL(request.url).searchParams.get("until") ?? 0) + 1 } })));
    expect(await listProjectDomains(token, "team_a", "p1")).toMatchObject({ ok: false, kind: "transient" });
  });
  it("fails when a later page fails, never returning the first page alone", async () => {
    server.use(http.get("https://api.vercel.com/v9/projects/p1/domains", ({ request }) =>
      new URL(request.url).searchParams.get("until")
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ domains: [{ name: "a.example.com" }], pagination: { next: 5 } })));
    expect(await listProjectDomains(token, "team_a", "p1")).toMatchObject({ ok: false });
  });
});

describe("listProjectDomains", () => {
  it("passes the custom environment through", async () => {
    server.use(http.get("https://api.vercel.com/v9/projects/p1/domains", () => HttpResponse.json({ domains: [{ name: "x.example.com", verified: false, customEnvironmentId: "env_1" }] })));
    expect(await listProjectDomains(token, "team_a", "p1")).toEqual({ ok: true, data: [{ name: "x.example.com", redirect: null, verified: false, gitBranch: null, customEnvironmentId: "env_1" }] });
  });
});

describe("listProjects: production aliases (1.2.1)", () => {
  it("reads targets.production.alias, empty when missing", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({
      projects: [{ ...project("p1", "one", { id: "dpl_1", readyState: "READY" }), targets: { production: { id: "dpl_1", readyState: "READY", alias: ["one.example.com"] } } }, project("p2", "two")],
      pagination: { next: null },
    })));
    const r = await listProjects(token, team);
    expect(r.ok && r.data.map((p) => p.productionAliases)).toEqual([["one.example.com"], []]);
  });
});

describe("listProjects", () => {
  it("follows pagination and passes teamId", async () => {
    const seen: string[] = [];
    server.use(http.get("https://api.vercel.com/v10/projects", ({ request }) => {
      const url = new URL(request.url);
      seen.push(`${url.searchParams.get("teamId")}:${url.searchParams.get("until") ?? "-"}`);
      return url.searchParams.get("until")
        ? HttpResponse.json({ projects: [project("p2", "two")], pagination: { next: null } })
        : HttpResponse.json({ projects: [project("p1", "one", { id: "dpl_1", readyState: "READY" })], pagination: { next: 123 } });
    }));
    const r = await listProjects(token, team);
    expect(seen).toEqual(["team_a:-", "team_a:123"]);
    expect(r.ok && r.data.map((p) => [p.id, p.currentDeploymentId, p.productionBranch])).toEqual([["p1", "dpl_1", "main"], ["p2", null, "main"]]);
  });

  it("leaves currentDeploymentId empty when the latest production deployment is not READY", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({
      projects: [project("p1", "one", { id: "dpl_x", readyState: "ERROR" })], pagination: { next: null },
    })));
    const r = await listProjects(token, team);
    expect(r.ok && r.data[0].currentDeploymentId).toBeNull();
  });

  it("reports a 429 as transient with the Retry-After seconds", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => new HttpResponse(null, { status: 429, headers: { "Retry-After": "17" } })));
    expect(await listProjects(token, team)).toMatchObject({ ok: false, kind: "transient", retryAfterS: 17 });
  });
});

describe("listDeployments", () => {
  it("reads commit fields from git and CLI deployments", async () => {
    server.use(http.get("https://api.vercel.com/v7/deployments", () => HttpResponse.json({
      deployments: [
        { uid: "d1", projectId: "p1", state: "READY", target: "production", source: "git", url: "a.vercel.app", createdAt: 1000, buildingAt: 1100, ready: 5000,
          meta: { githubCommitSha: "abcdef1234", githubCommitRef: "main", githubCommitMessage: "feat: x" } },
        { uid: "d2", projectId: "p1", readyState: "BUILDING", target: null, source: "cli", url: null, created: 2000, buildingAt: null, ready: null,
          meta: { gitCommitSha: "1234567890", gitCommitRef: "dev", gitCommitMessage: "wip" } },
      ],
      pagination: {},
    })));
    const r = await listDeployments(token, team, { since: 0 });
    expect(r.ok && r.data).toEqual([
      { id: "d1", projectId: "p1", state: "ready", rawState: "READY", target: "production", branch: "main", sha: "abcdef1234", message: "feat: x", source: "git", url: "a.vercel.app",
        createdAt: new Date(1000), buildingAt: new Date(1100), readyAt: new Date(5000) },
      { id: "d2", projectId: "p1", state: "building", rawState: "BUILDING", target: "preview", branch: "dev", sha: "1234567890", message: "wip", source: "cli", url: null,
        createdAt: new Date(2000), buildingAt: null, readyAt: null },
    ]);
  });
});

describe("getDeployment", () => {
  it("reads one deployment by id with teamId (v13 returns `id`, not `uid`)", async () => {
    let seen = "";
    server.use(http.get("https://api.vercel.com/v13/deployments/dpl_old", ({ request }) => {
      seen = new URL(request.url).search;
      return HttpResponse.json({
        id: "dpl_old", projectId: "p1", readyState: "READY", target: "production", source: "git", url: "shortly-abc.vercel.app",
        createdAt: 1_752_900_000_000, buildingAt: 1_752_900_010_000, ready: 1_752_900_060_000,
        meta: { githubCommitSha: "abcdef1234", githubCommitRef: "main", githubCommitMessage: "feat: x" },
      });
    }));
    const r = await getDeployment(token, team, "dpl_old");
    expect(seen).toBe("?teamId=team_a");
    expect(r.ok && r.data).toEqual({
      id: "dpl_old", projectId: "p1", state: "ready", rawState: "READY", target: "production", branch: "main", sha: "abcdef1234", message: "feat: x",
      source: "git", url: "shortly-abc.vercel.app", createdAt: new Date(1_752_900_000_000), buildingAt: new Date(1_752_900_010_000), readyAt: new Date(1_752_900_060_000),
    });
  });
  it("reports a 404 as transient and a body without an id as a format problem", async () => {
    server.use(http.get("https://api.vercel.com/v13/deployments/gone", () => new HttpResponse(null, { status: 404 })));
    expect(await getDeployment(token, team, "gone")).toMatchObject({ ok: false, kind: "transient", status: 404 });
    server.use(http.get("https://api.vercel.com/v13/deployments/odd", () => HttpResponse.json({ nope: 1 })));
    expect(await getDeployment(token, team, "odd")).toMatchObject({ ok: false, kind: "format" });
  });
});

describe("tokenExpiry", () => {
  it("returns the expiry date, or null when the token never expires", async () => {
    server.use(http.get("https://api.vercel.com/v5/user/tokens/current", () => HttpResponse.json({ token: { expiresAt: 1_800_000_000_000 } })));
    expect(await tokenExpiry(token)).toEqual({ ok: true, data: new Date(1_800_000_000_000) });
    server.use(http.get("https://api.vercel.com/v5/user/tokens/current", () => HttpResponse.json({ token: {} })));
    expect(await tokenExpiry(token)).toEqual({ ok: true, data: null });
  });
});

describe("discoverVercel", () => {
  it("lists apps from every team and skips a team the token can't read", async () => {
    server.use(
      http.get("https://api.vercel.com/v2/teams", () => HttpResponse.json({ teams: [team, { id: "team_b", slug: "perpus", name: "perpus" }] })),
      http.get("https://api.vercel.com/v10/projects", ({ request }) =>
        new URL(request.url).searchParams.get("teamId") === "team_b"
          ? new HttpResponse(null, { status: 403 })
          : HttpResponse.json({ projects: [project("p1", "one")], pagination: { next: null } })),
    );
    const r = await discoverVercel(token);
    expect(r).toEqual({
      ok: true,
      data: {
        apps: [{ externalId: "p1", name: "one", meta: { teamId: "team_a", teamSlug: "acme-team", teamName: "Acme' projects", framework: "nextjs", productionBranch: "main", createdAt: new Date(1_760_000_000_000).toISOString(), repo: null, repoType: null, functionRegions: [], rootDirectory: null } }],
        skippedTeams: ["perpus"],
        skippedTeamIds: ["team_b"],
      },
    });
  });

  it("treats a 401 on the team list as a bad credential", async () => {
    server.use(http.get("https://api.vercel.com/v2/teams", () => new HttpResponse(null, { status: 401 })));
    expect(await discoverVercel(token)).toMatchObject({ ok: false, kind: "auth" });
  });

  it("fails when a team answers 401 instead of skipping it", async () => {
    server.use(
      http.get("https://api.vercel.com/v2/teams", () => HttpResponse.json({ teams: [team, { id: "team_b", slug: "perpus", name: "perpus" }] })),
      http.get("https://api.vercel.com/v10/projects", ({ request }) =>
        new URL(request.url).searchParams.get("teamId") === "team_b"
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ projects: [project("p1", "one")], pagination: { next: null } })),
    );
    expect(await discoverVercel(token)).toMatchObject({ ok: false, kind: "auth" });
  });

  it("fails instead of returning an empty discovery when every team is unreadable", async () => {
    server.use(
      http.get("https://api.vercel.com/v2/teams", () => HttpResponse.json({ teams: [team] })),
      http.get("https://api.vercel.com/v10/projects", () => new HttpResponse(null, { status: 403 })),
    );
    expect(await discoverVercel(token)).toEqual({
      ok: false, kind: "auth", error: "This token can't read any of your Vercel teams. Create a token with access to them.",
    });
  });
});

describe("listProjectDomains and domainConfig", () => {
  it("lists a project's domains with teamId", async () => {
    server.use(http.get("https://api.vercel.com/v9/projects/prj_1/domains", ({ request }) => {
      expect(new URL(request.url).searchParams.get("teamId")).toBe("team_a");
      return HttpResponse.json({ domains: [{ name: "app.example.com", verified: true }, { name: "www.example.com", redirect: "app.example.com", verified: true }] });
    }));
    expect(await listProjectDomains(token, "team_a", "prj_1")).toEqual({ ok: true, data: [
      { name: "app.example.com", redirect: null, verified: true, gitBranch: null, customEnvironmentId: null },
      { name: "www.example.com", redirect: "app.example.com", verified: true, gitBranch: null, customEnvironmentId: null },
    ] });
  });
  it("reads misconfigured, configuredBy and the recommended IPs", async () => {
    server.use(http.get("https://api.vercel.com/v6/domains/app.example.com/config", () => HttpResponse.json({
      acceptedChallenges: ["http-01"], configuredBy: "CNAME", misconfigured: false,
      recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }, { rank: 2, value: ["76.76.21.21"] }], recommendedCNAME: [{ rank: 1, value: "x.vercel-dns-017.com." }],
    })));
    expect(await domainConfig(token, "team_a", "app.example.com")).toEqual({ ok: true, data: { misconfigured: false, configuredBy: "CNAME", recommendedIps: ["216.198.79.1", "76.76.21.21"] } });
  });
});

describe("listProjects extras (P2)", () => {
  it("reads the GitHub repo and the function regions when present", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({ projects: [{
      ...project("prj_1", "web"), link: { type: "github", org: "acme", repo: "web", productionBranch: "main" },
      resourceConfig: { functionDefaultRegions: ["sin1"] },
    }] })));
    const r = await listProjects(token, team);
    expect(r.ok && r.data[0].repo).toEqual({ type: "github", org: "acme", repo: "web" });
    expect(r.ok && r.data[0].functionRegions).toEqual(["sin1"]);
  });

  // Watchbell 1.2: the Root Directory (a monorepo's "apps/web") goes to resources.meta.rootDirectory through the sync.
  it("reads the Root Directory, cleaned; the root and anything odd are null", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({ projects: [
      { ...project("prj_1", "web"), rootDirectory: "apps/web" },
      { ...project("prj_2", "site"), rootDirectory: "./apps/site/" },
      { ...project("prj_3", "root"), rootDirectory: null },
      { ...project("prj_4", "odd"), rootDirectory: "../x" },
      { ...project("prj_5", "weird"), rootDirectory: 42 },
    ] })));
    const r = await listProjects(token, team);
    expect(r.ok && r.data.map((p) => p.rootDirectory)).toEqual(["apps/web", "apps/site", null, null, null]);
    // review T1 minor 4: a Root Directory that can't be used is kept as text, so it isn't silently the root
    expect(r.ok && r.data.map((p) => p.rootDirectoryUnsupported)).toEqual([null, null, null, "../x", null]);
  });

  it("discovery puts an unusable Root Directory into meta.rootDirectoryUnsupported (only when there is one)", async () => {
    server.use(
      http.get("https://api.vercel.com/v2/teams", () => HttpResponse.json({ teams: [team] })),
      http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({ projects: [{ ...project("p1", "web"), rootDirectory: "my app" }, { ...project("p2", "site"), rootDirectory: "apps/site" }] })),
    );
    const r = await discoverVercel(token);
    expect(r.ok && r.data.apps.map((a) => [a.meta.rootDirectory, a.meta.rootDirectoryUnsupported])).toEqual([[null, "my app"], ["apps/site", undefined]]);
    expect(r.ok && Object.hasOwn(r.data.apps[1].meta, "rootDirectoryUnsupported")).toBe(false);
  });
});

// Stage 6 (A1): the only Vercel writes. Each test pins method, path, teamId and body.
describe("writes", () => {
  const TEAM = "team_a";
  const P = "prj_abc123";
  const D = "dpl_AbCdEfGh1234";
  type Seen = { method: string; path: string; teamId: string | null; body: unknown };
  const seen: Seen[] = [];
  const record = async (request: Request) => {
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    seen.push({ method: request.method, path: url.pathname, teamId: url.searchParams.get("teamId"), body: text ? JSON.parse(text) : null });
  };
  beforeEach(() => { seen.length = 0; });

  const writes = [
    ["redeploy", () => redeploy(token, TEAM, { projectId: P, name: "web", deploymentId: D })],
    ["rollback", () => rollback(token, TEAM, P, D)],
    ["promote", () => promote(token, TEAM, P, D)],
    ["cancelDeployment", () => cancelDeployment(token, TEAM, D)],
    ["promotePreview", () => promotePreview(token, TEAM, { projectId: P, name: "web", deploymentId: D })],
  ] as const;

  it("redeploy POSTs /v13/deployments with the current production deployment, same commit, no withLatestCommit", async () => {
    server.use(http.post("https://api.vercel.com/v13/deployments", async ({ request }) => { await record(request); return HttpResponse.json({ id: "dpl_new12345678" }); }));
    expect(await redeploy(token, TEAM, { projectId: P, name: "web", deploymentId: D })).toEqual({ ok: true, data: { id: "dpl_new12345678" } });
    expect(seen).toEqual([{ method: "POST", path: "/v13/deployments", teamId: TEAM, body: { name: "web", project: P, deploymentId: D, target: "production" } }]);
    expect(seen[0].body).not.toHaveProperty("withLatestCommit");
  });

  it("rollback POSTs /v1/projects/{id}/rollback/{deployment}", async () => {
    server.use(http.post("https://api.vercel.com/v1/projects/:p/rollback/:d", async ({ request }) => { await record(request); return new HttpResponse(null, { status: 201 }); }));
    expect(await rollback(token, TEAM, P, D)).toEqual({ ok: true, data: null });
    expect(seen.map((x) => [x.method, x.path, x.teamId])).toEqual([["POST", `/v1/projects/${P}/rollback/${D}`, TEAM]]);
  });

  it("promote POSTs /v10/projects/{id}/promote/{deployment}", async () => {
    server.use(http.post("https://api.vercel.com/v10/projects/:p/promote/:d", async ({ request }) => { await record(request); return new HttpResponse(null, { status: 202 }); }));
    expect(await promote(token, TEAM, P, D)).toEqual({ ok: true, data: null });
    expect(seen.map((x) => [x.method, x.path, x.teamId])).toEqual([["POST", `/v10/projects/${P}/promote/${D}`, TEAM]]);
    // Slice 2: the empty JSON body the Vercel CLI marks as required.
    expect(seen[0].body).toEqual({});
  });

  it("promotePreview POSTs /v13/deployments with the preview, target production and meta.action promote (what vercel promote does)", async () => {
    server.use(http.post("https://api.vercel.com/v13/deployments", async ({ request }) => { await record(request); return HttpResponse.json({ id: "dpl_new12345678" }); }));
    expect(await promotePreview(token, TEAM, { projectId: P, name: "web", deploymentId: D })).toEqual({ ok: true, data: { id: "dpl_new12345678" } });
    expect(seen).toEqual([{ method: "POST", path: "/v13/deployments", teamId: TEAM, body: { name: "web", project: P, deploymentId: D, target: "production", meta: { action: "promote" } } }]);
  });

  it("cancelDeployment PATCHes /v12/deployments/{id}/cancel", async () => {
    server.use(http.patch("https://api.vercel.com/v12/deployments/:d/cancel", async ({ request }) => { await record(request); return HttpResponse.json({ id: D, readyState: "CANCELED" }); }));
    expect(await cancelDeployment(token, TEAM, D)).toEqual({ ok: true, data: null });
    expect(seen.map((x) => [x.method, x.path, x.teamId])).toEqual([["PATCH", `/v12/deployments/${D}/cancel`, TEAM]]);
  });

  it.each(writes)("%s: 403 is a scope failure, 401 an auth failure, 429 transient with Retry-After", async (_n, call) => {
    let status = 403;
    server.use(http.all("https://api.vercel.com/*", () => new HttpResponse(JSON.stringify({ error: { code: "forbidden", message: "secret body" } }), { status, headers: { "Retry-After": "30" } })));
    const forbidden = await call();
    expect(forbidden).toMatchObject({ ok: false, kind: "scope", status: 403 });
    expect(JSON.stringify(forbidden)).not.toContain("secret body");
    status = 401;
    expect(await call()).toMatchObject({ ok: false, kind: "auth", status: 401, error: "Vercel rejected this credential (401)." });
    status = 429;
    expect(await call()).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 30 });
  });

  it("a refused write names Vercel's error code, never its message", async () => {
    server.use(http.post("https://api.vercel.com/v10/projects/:p/promote/:d", () => HttpResponse.json({ error: { code: "not_found", message: "Deployment https://x?token=1 gone" } }, { status: 404 })));
    expect(await promote(token, TEAM, P, D)).toEqual({ ok: false, kind: "transient", status: 404, error: "Vercel refused this (404, not_found)." });
  });

  it("a write that times out says it may still have happened", async () => {
    server.use(http.post("https://api.vercel.com/v1/projects/:p/rollback/:d", async () => { await new Promise((r) => setTimeout(r, 200)); return new HttpResponse(null, { status: 201 }); }));
    const r = await rollback(token, TEAM, P, D, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, kind: "transient" });
    expect(!r.ok && r.error).toContain("may still have happened");
  });

  it("the five writes make exactly the A1 and B1 calls, only POST and PATCH, nothing else", async () => {
    server.use(http.all("https://api.vercel.com/*", async ({ request }) => { await record(request); return HttpResponse.json({ id: "dpl_new12345678" }); }));
    for (const [, call] of writes) expect((await call()).ok).toBe(true);
    expect(seen.map((x) => `${x.method} ${x.path}?teamId=${x.teamId}`)).toEqual([
      "POST /v13/deployments?teamId=team_a",
      `POST /v1/projects/${P}/rollback/${D}?teamId=team_a`,
      `POST /v10/projects/${P}/promote/${D}?teamId=team_a`,
      `PATCH /v12/deployments/${D}/cancel?teamId=team_a`,
      "POST /v13/deployments?teamId=team_a",
    ]);
    expect([...new Set(seen.map((x) => x.method))].sort()).toEqual(["PATCH", "POST"]);
  });
});

describe("live reads before a write", () => {
  const TEAM = "team_a";
  const P = "prj_abc123";
  const dep = (uid: string, created: number, state = "READY") => ({ uid, name: "web", url: `${uid}.vercel.app`, created, state, target: "production", meta: { githubCommitSha: `${uid}sha0000` } });

  it("currentProduction reads the project's READY production target", async () => {
    let q = "";
    server.use(http.get("https://api.vercel.com/v9/projects/:p", ({ request, params }) => {
      q = `${String(params.p)}?${new URL(request.url).searchParams.toString()}`;
      return HttpResponse.json({ id: P, name: "web", targets: { production: { id: "dpl_cur1234567", readyState: "READY" } } });
    }));
    expect(await currentProduction(token, TEAM, P)).toEqual({ ok: true, data: { name: "web", currentId: "dpl_cur1234567" } });
    expect(q).toBe(`${P}?teamId=team_a`);
    server.use(http.get("https://api.vercel.com/v9/projects/:p", () => HttpResponse.json({ id: P, name: "web", targets: { production: { id: "dpl_bad", readyState: "ERROR" } } })));
    expect(await currentProduction(token, TEAM, P)).toEqual({ ok: true, data: { name: "web", currentId: null } });
  });

  // targets.production is the latest production deployment (spec §7.1). After a roll back Vercel serves an older one
  // and stops auto-assigning production until a promote; lastAliasRequest names where production was moved.
  const projectWith = (production: { id: string; readyState: string; createdAt?: number }, last: unknown) => ({ id: P, name: "web", targets: { production }, lastAliasRequest: last });
  const rolledBack = { type: "rollback", jobStatus: "succeeded", fromDeploymentId: "dpl_new1234567", toDeploymentId: "dpl_prv1234567", requestedAt: 5000 };

  it("currentProduction: after a roll back the live one is the roll back's target, even when a newer build is READY", async () => {
    server.use(http.get("https://api.vercel.com/v9/projects/:p", () => HttpResponse.json(projectWith({ id: "dpl_new1234567", readyState: "READY", createdAt: 4000 }, rolledBack))));
    expect(await currentProduction(token, TEAM, P)).toEqual({ ok: true, data: { name: "web", currentId: "dpl_prv1234567" } });
    // A push after the roll back is built but stays staged: still the roll back's target.
    server.use(http.get("https://api.vercel.com/v9/projects/:p", () => HttpResponse.json(projectWith({ id: "dpl_stg1234567", readyState: "READY", createdAt: 9000 }, rolledBack))));
    expect(await currentProduction(token, TEAM, P)).toEqual({ ok: true, data: { name: "web", currentId: "dpl_prv1234567" } });
  });

  it("currentProduction: a promote is live until a newer production build replaces it; unfinished requests are ignored", async () => {
    const promoted = { type: "promote", jobStatus: "succeeded", fromDeploymentId: "dpl_prv1234567", toDeploymentId: "dpl_stg1234567", requestedAt: 5000 };
    const answer = (production: { id: string; readyState: string; createdAt?: number }, last: unknown) => {
      server.use(http.get("https://api.vercel.com/v9/projects/:p", () => HttpResponse.json(projectWith(production, last))));
      return currentProduction(token, TEAM, P).then((r) => r.ok && r.data.currentId);
    };
    // Promoted an older staged build while a newer one exists: the promoted one is live.
    expect(await answer({ id: "dpl_new1234567", readyState: "READY", createdAt: 4000 }, promoted)).toBe("dpl_stg1234567");
    // A push after the promote went live again (or failed: then the newest READY one is used by the caller).
    expect(await answer({ id: "dpl_nxt1234567", readyState: "READY", createdAt: 6000 }, promoted)).toBe("dpl_nxt1234567");
    expect(await answer({ id: "dpl_nxt1234567", readyState: "ERROR", createdAt: 6000 }, promoted)).toBeNull();
    // Without a creation time Vercel's own answer stands.
    expect(await answer({ id: "dpl_new1234567", readyState: "READY" }, promoted)).toBe("dpl_new1234567");
    // A roll back still running, failed or skipped doesn't move production; an unknown shape is ignored.
    for (const jobStatus of ["pending", "in-progress", "failed", "skipped"]) {
      expect(await answer({ id: "dpl_new1234567", readyState: "READY", createdAt: 4000 }, { ...rolledBack, jobStatus })).toBe("dpl_new1234567");
    }
    expect(await answer({ id: "dpl_new1234567", readyState: "READY", createdAt: 4000 }, { odd: true })).toBe("dpl_new1234567");
  });

  it("listProjects places current the same way, so the collector's Current flag follows a roll back (A9)", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({
      projects: [{ ...project("p1", "one", { id: "dpl_new1234567", readyState: "READY" }), lastAliasRequest: rolledBack }], pagination: { next: null },
    })));
    const r = await listProjects(token, team);
    expect(r.ok && r.data[0].currentDeploymentId).toBe("dpl_prv1234567");
  });

  it("productionDeployments asks v6 for the 5 newest READY production deployments", async () => {
    let params: Record<string, string> = {};
    server.use(http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
      params = Object.fromEntries(new URL(request.url).searchParams);
      return HttpResponse.json({ deployments: [dep("dpl_b", 2000), dep("dpl_a", 1000)] });
    }));
    const r = await productionDeployments(token, TEAM, P);
    expect(params).toEqual({ projectId: P, target: "production", state: "READY", limit: "5", teamId: TEAM });
    expect(r.ok && r.data.map((d) => [d.id, d.projectId, d.state, d.target, d.sha])).toEqual([
      ["dpl_b", P, "ready", "production", "dpl_bsha0000"], ["dpl_a", P, "ready", "production", "dpl_asha0000"],
    ]);
  });

  it("runningProductionBuild asks for one queued or building production deployment", async () => {
    let params: Record<string, string> = {};
    server.use(http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
      params = Object.fromEntries(new URL(request.url).searchParams);
      return HttpResponse.json({ deployments: [dep("dpl_run", 3000, "BUILDING")] });
    }));
    const r = await runningProductionBuild(token, TEAM, P);
    expect(params).toEqual({ projectId: P, target: "production", state: "BUILDING,QUEUED,INITIALIZING", limit: "1", teamId: TEAM });
    expect(r.ok && r.data?.id).toBe("dpl_run");
    server.use(http.get("https://api.vercel.com/v6/deployments", () => HttpResponse.json({ deployments: [] })));
    expect(await runningProductionBuild(token, TEAM, P)).toEqual({ ok: true, data: null });
  });
});
