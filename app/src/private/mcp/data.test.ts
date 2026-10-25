import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";

// The R5 leak test for every MCP read tool: the real data layer (data.ts) and tools (tools.ts) over core readers that
// return the worst rows imaginable. No tool output may contain a leak-list string, a database's real name, a host,
// an IP, an account label or an email.

const APP = "0b6f7c1e-1111-4222-8333-944445555666";
const DB = "2b6f7c1e-1111-4222-8333-944445555666";
const ALERT = "3b6f7c1e-1111-4222-8333-944445555666";
const SECRET = "postgres://admin:hunter2@db.abcd.supabase.co:5432/ticketer-prod-db owner owner@example.com 10.1.2.3 wp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn sk-proj-abcdefghij gsk_abcdefghijkl AIzaSyA1234567890abcdefghij /api/ping/hb_0123456789abcdef0123456789abcdef https://shop.example.com/x?token=abc";
const t = new Date("2026-10-13T02:00:00Z");

const monitor = {
  id: "m1", appId: APP, url: "https://shop.example.com/health?token=abc", path: "/health?token=abc", state: "err", lastStatus: 503, lastLatencyMs: 812, failStreak: 3,
  paused: false, ownerPaused: false, lastCheckedAt: t, expectedStatus: 200, timeoutMs: 10000, intervalS: 60, bodyContains: null, jsonPath: null, jsonEquals: null,
  lastError: SECRET, kind: "http", name: null, periodS: null, graceS: null, lastPingAt: null, stateSince: t, maintUntil: null,
  move: { from: "old.example.com", to: "shop.example.com" }, // Watchbell 1.2.1: told as a flag, never the hosts
};
const app = {
  id: APP, name: "ticketer", gone: false, state: "err", stateSince: t, domain: "shop.example.com", framework: "nextjs", productionBranch: "main", createdAt: t,
  teamName: "Acme team owner@example.com", teamSlug: "acme", repo: "acme/ticketer", repoType: "github", functionRegions: ["sin1"], domainLines: { lines: [{ name: "shop.example.com", tag: null, target: null }], more: 0 }, monitors: [monitor],
  lastDeploy: { id: "dep", state: "error", target: "production", branch: "main", commitSha: "abcdef1234567", commitMessage: `fix ${SECRET}`, url: "ticketer-abc.vercel.app", createdAt: t, buildingAt: t, readyAt: t, isCurrent: true, isPreviousProduction: false },
  uptime30: 99.1, response: { hourly: [], p95: 900, p50: 300 }, days: new Map(), security: null,
  database: { id: DB, externalId: "abcd1234supabaseref", name: "ticketer-prod-db", kind: "supabase_project", account: "Acme Supabase", state: "warn" }, dbPaused: true,
  pageViews: null, pageViewsNote: null,
};

vi.mock("@/lib/data/aliases-db", () => ({
  readAliasBook: async () => buildAliasBook([
    { id: DB, kind: "supabase_project", name: "ticketer-prod-db", firstSeenAt: "2026-01-01T00:00:00Z" },
    { id: APP, kind: "app", name: "ticketer", firstSeenAt: "2026-01-01T00:00:00Z" },
    { id: "dom", kind: "domain", name: "shop.example.com", firstSeenAt: "2026-01-02T00:00:00Z", parentId: APP },
  ], [{ id: "acc", label: "Acme Supabase", createdAt: "2026-01-01T00:00:00Z" }]),
}));
vi.mock("@/db/client", () => {
  const b: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) b[m] = () => b;
  b.then = (res: (v: unknown) => void) => res([{ id: APP, name: "ticketer" }]);
  return { db: () => ({ select: () => b }) };
});
vi.mock("@/lib/data/apps-db", () => ({ listApps: async () => [app], getApp: async (id: string) => (id === APP ? app : null) }));
vi.mock("@/lib/data/monitors-db", () => ({ listMonitors: async () => [{ ...monitor, appName: "ticketer", appGone: false, days: undefined, uptime30: 98.5 }] }));
vi.mock("@/lib/data/alerts-db", () => ({
  listShownFiring: async () => [{
    id: ALERT, ruleKey: "db-paused", subject: "ticketer-prod-db", resourceId: DB, accountId: "acc", severity: "critical", title: "ticketer-prod-db is paused",
    message: SECRET, startedAt: t, lastSeenAt: t, resolvedAt: null, okStreak: 0, lastSampleAt: t, silencedUntil: null, silencedUntilResolved: false, silencedBy: null,
    causedBy: SECRET, providerIncident: null, notifiedOpen: true, lastNotifiedAt: t, resourceName: "ticketer-prod-db", resourceKind: "supabase_project",
  }],
  listResolved: async () => [{ id: "r1", ruleKey: "tls", severity: "warning", title: "TLS for shop.example.com expires (owner@example.com)", resourceId: "dom", startedAt: t, resolvedAt: t }],
}));
vi.mock("@/lib/data/events-db", () => ({
  listEvents: async () => [{ id: "e1", at: t, lastAt: null, count: 1, reason: null, type: "database", kind: "warn", message: `ticketer-prod-db paused ${SECRET}`, detail: SECRET, resource: "ticketer-prod-db", resourceId: DB }],
}));
vi.mock("@/lib/data/logs-db", () => ({
  listStoredLogs: async () => [{ id: "l1", at: t, level: "error", app: "ticketer", method: "GET", path: "/api/pay?token=abc&email=x@y.co", status: 500, message: SECRET }],
}));
vi.mock("@/lib/data/databases-db", () => ({
  listDatabases: async (kind: string) => kind === "supabase_project"
    ? [{ id: DB, name: "ticketer-prod-db", externalId: "abcd1234supabaseref", kind, account: "Acme Supabase", state: "warn", stateSince: t, collectedAt: t, data: { host: "db.abcd.supabase.co" }, usedBy: [{ id: APP, name: "ticketer" }] }]
    : [],
}));
vi.mock("@/lib/data/advisor-db", () => ({
  listRecommendations: async () => [{ key: `db-unlinked:${DB}`, severity: "warning", appId: APP, subject: "ticketer-prod-db", title: "Link ticketer-prod-db", why: SECRET, fix: "Open https://supabase.com/dashboard/project/abcd1234supabaseref", href: "/databases" }],
}));
vi.mock("./notes-db", () => ({
  pendingQuestions: async () => [{ id: "q1", contextKind: "app", contextId: APP, question: `Why? ${SECRET}`, createdAt: "2026-10-13T02:00:00.000Z" },
    { id: "q2", contextKind: "alert", contextId: ALERT, question: "And this alert?", createdAt: "2026-10-13T02:05:00.000Z" }],
  insertNote: vi.fn(), answerQuestion: vi.fn(), allowedModels: vi.fn(), NOTES_PER_HOUR: 20, ANSWERS_PER_HOUR: 60,
}));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: vi.fn() }));

import { findTool, type ToolCtx } from "./tools";

const LEAKS = ["@", "://", "postgres", "wp_", "hb_", "sk-", "gsk_", "AIza", "hunter2", "ticketer-prod-db", "example.com", "10.1.2.3", "Acme Supabase", "abcd1234supabaseref", "supabase.co", "token=abc", "vercel.app"];
const ctx: ToolCtx = {
  key: { keyId: "k1", name: "laptop", prefix: "wp_Lm9x", scopes: ["read:status"], ratePerMin: 20, providerId: null, model: null, client: { name: "antigravity", version: "1", via: "mcp", userAgent: "" } },
  now: new Date("2026-10-13T03:00:00Z"),
};

const CALLS: [string, Record<string, unknown>][] = [
  ["list_apps", {}], ["get_app", { app: "ticketer" }], ["list_alerts", {}], ["list_alerts", { state: "recent" }], ["list_monitors", {}],
  ["recent_events", { limit: 5 }], ["recent_logs", {}], ["recent_logs", { app: APP }], ["list_databases", {}], ["get_advisor", {}], ["get_advisor", { app: "ticketer" }],
  ["list_pending_questions", {}],
];

beforeEach(() => vi.clearAllMocks());

describe("MCP read tools leak nothing (R5)", () => {
  for (const [name, args] of CALLS) {
    it(`${name} ${JSON.stringify(args)}`, async () => {
      const r = await findTool(name)!.call(args, ctx);
      expect(r.isError).toBeUndefined();
      const out = JSON.stringify(r);
      for (const s of LEAKS) expect(out, `${name} leaks ${s}`).not.toContain(s);
    });
  }

  it("still says what matters: aliases, app names, paths, states and problems", async () => {
    const r = await findTool("get_app")!.call({ app: "ticketer" }, ctx);
    const a = (r.structuredContent as { app: Record<string, unknown> }).app;
    expect(a).toMatchObject({ id: APP, name: "ticketer", state: "err", database: { alias: "db-a", kind: "supabase_project", paused: true } });
    expect(a.monitors).toEqual([expect.objectContaining({ path: "/health", state: "err", lastStatus: 503, domainMoved: true })]);
    expect(a.domainMoved).toBe(true);
    expect((a.problems as { where: string }[]).map((p) => p.where)).toEqual(["Monitor /health", "Database db-a", "Production deployment abcdef1"]);
    const dbs = await findTool("list_databases")!.call({}, ctx);
    expect(dbs.structuredContent).toEqual({ databases: [{ alias: "db-a", kind: "supabase_project", state: "warn", stateSince: t.toISOString(), usedBy: ["ticketer"] }] });
  });

  it("pending questions carry the context they are about", async () => {
    const r = await findTool("list_pending_questions")!.call({}, ctx);
    const qs = (r.structuredContent as { questions: { id: string; context: Record<string, unknown> | null }[] }).questions;
    expect(qs[0].context).toMatchObject({ id: APP, name: "ticketer", state: "err" });
    expect(qs[1].context).toMatchObject({ id: ALERT, severity: "critical", title: "db-a", open: true });
  });
});
