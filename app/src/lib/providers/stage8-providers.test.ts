import { describe, expect, it } from "vitest";
import { D1_USAGE_QUERY, d1UsageOn, getD1, listAccounts, listD1, parseD1Usage, utcDay } from "./cloudflare-d1";
import { discoverTurso, listTursoOrgs, parseTursoOrgUsage, tursoOrgUsage } from "./turso";
import { listUpstashRedis, parseUpstashCred, parseUpstashStats, upstashStats } from "./upstash";

// Stage 8 adapters against fixtures shaped like the official API references (checked 16 Oct 2026). No network: every
// call goes through a fake fetch that records the method, URL and headers.
type Call = { method: string; url: string; auth: string | null; body: string | null };
function fake(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, auth: h.get("Authorization"), body: typeof init?.body === "string" ? init.body : null });
    // The longest matching route wins, so "/v1/organizations" doesn't answer for "/v1/organizations/me/databases".
    const key = Object.keys(routes).sort((x, y) => y.length - x.length).find((k) => url.endsWith(k) || url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const TURSO_TOKEN = "turso-platform-token-for-tests-000000";

describe("Turso", () => {
  const orgs = [{ name: "personal", slug: "me", type: "personal", plan_id: "free", blocked_reads: false, blocked_writes: false, overages: false }];
  const dbs = { databases: [
    { Name: "notes", DbId: "db-uuid-1", Hostname: "notes-me.turso.io", group: "default", primaryRegion: "aws-ap-northeast-1", block_reads: false, block_writes: false, regions: ["nrt"], delete_protection: false, parent: null },
    { Name: "cache", DbId: "db-uuid-2", Hostname: "cache-me.turso.io", group: "default", primaryRegion: "aws-ap-northeast-1", block_reads: false, block_writes: true },
  ] };
  const usage = {
    organization: { uuid: "org-uuid", usage: { rows_read: 125_000_000, rows_written: 2_500_000, databases: 2, locations: 1, storage_bytes: 1_073_741_824, groups: 1, bytes_synced: 0 } },
    databases: [
      { uuid: "db-uuid-1", instances: [], total: { rows_read: 100_000_000, rows_written: 2_000_000, storage_bytes: 805_306_368, bytes_synced: 0 } },
      { uuid: "db-uuid-2", instances: [], total: { rows_read: 25_000_000, rows_written: 500_000, storage_bytes: 268_435_456, bytes_synced: 0 } },
    ],
  };

  it("lists organizations and their databases with a Bearer token, GETs only", async () => {
    const f = fake({ "/v1/organizations": { body: orgs }, "/v1/organizations/me/databases": { body: dbs } });
    const r = await discoverTurso(TURSO_TOKEN, { fetch: f.fetch });
    expect(r.ok && r.data).toEqual([
      { id: "db-uuid-1", name: "notes", org: "me", group: "default", primaryRegion: "aws-ap-northeast-1", blockReads: false, blockWrites: false },
      { id: "db-uuid-2", name: "cache", org: "me", group: "default", primaryRegion: "aws-ap-northeast-1", blockReads: false, blockWrites: true },
    ]);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(f.calls.every((c) => c.auth === `Bearer ${TURSO_TOKEN}`)).toBe(true);
  });

  it("reads the organization's month and each database's total from one usage call", async () => {
    const f = fake({ "/v1/organizations/me/usage": { body: usage } });
    const r = await tursoOrgUsage(TURSO_TOKEN, "me", { fetch: f.fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.org).toEqual({ rowsRead: 125_000_000, rowsWritten: 2_500_000, storageBytes: 1_073_741_824, databases: 2 });
    expect(r.data.byDb.get("db-uuid-2")).toEqual({ rowsRead: 25_000_000, rowsWritten: 500_000, storageBytes: 268_435_456 });
  });

  it("calls an odd usage answer a format failure, and a 401 a rejected credential", async () => {
    expect(parseTursoOrgUsage({ organization: {} }).ok).toBe(false);
    const f = fake({ "/v1/organizations": { status: 401, body: { error: "unauthorized" } } });
    const r = await listTursoOrgs(TURSO_TOKEN, { fetch: f.fetch });
    expect(r.ok ? null : r.kind).toBe("auth");
  });
});

describe("Upstash", () => {
  const CRED = "owner@example.com:0123456789abcdef0123456789abcdef";
  const cred = parseUpstashCred(CRED)!;

  it("reads email:API_KEY (or a space between) and refuses anything else", () => {
    expect(cred).toEqual({ email: "owner@example.com", apiKey: "0123456789abcdef0123456789abcdef" });
    expect(parseUpstashCred("owner@example.com 0123456789abcdef0123456789abcdef")).toEqual(cred);
    for (const bad of ["", "0123456789abcdef0123456789abcdef", "not-an-email:0123456789abcdef0123456789abcdef", "owner@example.com:short"]) {
      expect(parseUpstashCred(bad)).toBeNull();
    }
  });

  it("signs with HTTP Basic, and keeps neither the endpoint nor the password of a database", async () => {
    const f = fake({ "/v2/redis/databases": { body: [
      { database_id: "u-1", database_name: "rate-limits", region: "global", primary_region: "ap-southeast-1", state: "active", type: "free", endpoint: "secret-host.upstash.io", password: "SECRET-PASSWORD", port: 6379, tls: true },
      { database_id: "u-2", database_name: "queue", region: "ap-northeast-1", state: "active", type: "free" },
    ] } });
    const r = await listUpstashRedis(cred, { fetch: f.fetch });
    expect(r.ok && r.data).toEqual([
      { id: "u-1", name: "rate-limits", region: "global · ap-southeast-1", state: "active", type: "free" },
      { id: "u-2", name: "queue", region: "ap-northeast-1", state: "active", type: "free" },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|secret-host/);
    expect(f.calls[0].auth).toBe(`Basic ${Buffer.from("owner@example.com:0123456789abcdef0123456789abcdef").toString("base64")}`);
    expect(f.calls[0].method).toBe("GET");
  });

  it("takes this month's commands and bandwidth and the current data size from the stats", async () => {
    const body = {
      daily_net_commands: 1200, daily_read_requests: 900, daily_write_requests: 300, total_monthly_requests: 410_000,
      total_monthly_bandwidth: 2_147_483_648, current_storage: 52_428_800, total_monthly_storage: 1, total_monthly_billing: 0,
      throughput: [{ x: "2026-10-16 01:00:00.000 +0000 UTC", y: 2 }],
    };
    const f = fake({ "/v2/redis/stats/u-1": { body } });
    const r = await upstashStats(cred, "u-1", { fetch: f.fetch });
    expect(r.ok && r.data).toEqual({ dailyCommands: 1200, monthlyRequests: 410_000, storageBytes: 52_428_800, monthlyBandwidthBytes: 2_147_483_648 });
    expect(parseUpstashStats({ current_storage: "big" }).ok).toBe(false);
  });
});

describe("Cloudflare D1", () => {
  const T = "cf-token-for-tests-0000000000000000";
  const ACC = "0123456789abcdef0123456789abcdef";
  const env = (result: unknown, extra: object = {}) => ({ success: true, errors: [], messages: [], result, ...extra });

  it("lists accounts and D1 databases, then one database's size; GETs only", async () => {
    const f = fake({
      "/accounts?per_page=50": { body: env([{ id: ACC, name: "Personal" }]) },
      [`/accounts/${ACC}/d1/database?per_page=100&page=1`]: { body: env([{ uuid: "d1-a", name: "blog", version: "production", created_at: "2026-09-01T00:00:00Z", jurisdiction: null }], { result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 } }) },
      [`/accounts/${ACC}/d1/database/d1-a`]: { body: env({ uuid: "d1-a", name: "blog", file_size: 1_572_864, num_tables: 4, read_replication: { mode: "disabled" } }) },
    });
    expect((await listAccounts(T, { fetch: f.fetch })).ok).toBe(true);
    const list = await listD1(T, ACC, { fetch: f.fetch });
    expect(list.ok && list.data).toEqual([{ uuid: "d1-a", name: "blog", createdAt: "2026-09-01T00:00:00Z", jurisdiction: null }]);
    const one = await getD1(T, ACC, "d1-a", { fetch: f.fetch });
    expect(one.ok && one.data).toEqual({ sizeBytes: 1_572_864, numTables: 4, readReplication: "disabled" });
    expect(new Set(f.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });

  it("names the missing permission when the token has no D1 read", async () => {
    const f = fake({ [`/accounts/${ACC}/d1/database`]: { status: 403, body: { success: false, errors: [{ code: 10000 }] } } });
    const r = await listD1(T, ACC, { fetch: f.fetch });
    expect(r.ok ? null : [r.kind, r.error]).toEqual(["scope", 'The token can\'t read this. Add "Account → D1 → Read" to the Cloudflare token.']);
  });

  it("sums today's rows per database from GraphQL, sent as variables in one POST", async () => {
    const body = { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
      { sum: { rowsRead: 1000, rowsWritten: 10, readQueries: 50, writeQueries: 5 }, dimensions: { databaseId: "d1-a" } },
      { sum: { rowsRead: 500, rowsWritten: 5, readQueries: 20, writeQueries: 1 }, dimensions: { databaseId: "d1-a" } },
      { sum: { rowsRead: 7, rowsWritten: 0, readQueries: 1, writeQueries: 0 }, dimensions: { databaseId: "d1-b" } },
    ] }] } }, errors: null };
    const f = fake({ "/client/v4/graphql": { body } });
    const r = await d1UsageOn(T, ACC, "2026-10-16", { fetch: f.fetch });
    expect(r.ok && r.data).toEqual([
      { databaseId: "d1-a", rowsRead: 1500, rowsWritten: 15, readQueries: 70, writeQueries: 6 },
      { databaseId: "d1-b", rowsRead: 7, rowsWritten: 0, readQueries: 1, writeQueries: 0 },
    ]);
    expect(f.calls[0].method).toBe("POST");
    expect(JSON.parse(f.calls[0].body!)).toEqual({ query: D1_USAGE_QUERY, variables: { accountTag: ACC, date: "2026-10-16" } });
  });

  it("reads a GraphQL authorization error as the Account Analytics permission, not a broken token", () => {
    const r = parseD1Usage({ data: null, errors: [{ message: "not authorized for that account" }] });
    expect(r.ok ? null : r.kind).toBe("scope");
    expect(r.ok ? "" : r.error).toContain("Account → Account Analytics → Read");
    expect(parseD1Usage({ data: null, errors: [{ message: "internal" }] })).toMatchObject({ ok: false, kind: "transient" });
    expect(parseD1Usage({ data: { viewer: { accounts: [] } } })).toEqual({ ok: true, data: [] });
  });

  it("counts D1's day in UTC (the quota resets at 00:00 UTC)", () => {
    expect(utcDay(new Date("2026-10-16T23:30:00+07:00"))).toBe("2026-10-16");
    expect(utcDay(new Date("2026-10-17T06:59:00+07:00"))).toBe("2026-10-16");
  });
});

describe("Test connection (stage 8)", () => {
  it("Turso: counts the databases and says whether usage can be read", async () => {
    const { testConnection } = await import("./test-connection");
    const f = fake({
      "/v1/organizations": { body: [{ name: "me", slug: "me", plan_id: "free" }] },
      "/v1/organizations/me/databases": { body: { databases: [{ Name: "notes", DbId: "db-1" }] } },
      "/v1/organizations/me/usage": { body: { organization: { usage: { rows_read: 1, rows_written: 1, storage_bytes: 1 } }, databases: [] } },
    });
    const r = await testConnection("turso", TURSO_TOKEN, { fetch: f.fetch });
    expect(r).toMatchObject({ ok: true, summary: "Found 1 database", scopeNote: "Databases and usage · no read-only option" });
  });
  it("Upstash: a rejected key is an auth failure; a stored value without the email is a format failure", async () => {
    const { testConnection } = await import("./test-connection");
    const f = fake({ "/v2/redis/databases": { status: 401, body: { error: "Unauthorized" } } });
    expect(await testConnection("upstash", "owner@example.com:0123456789abcdef0123456789abcdef", { fetch: f.fetch })).toMatchObject({ ok: false, kind: "auth" });
    expect(await testConnection("upstash", "0123456789abcdef0123456789abcdef", { fetch: f.fetch })).toMatchObject({ ok: false, kind: "format" });
  });
  it("Cloudflare: adds one D1 probe and names the permission when it is missing", async () => {
    const { testConnection } = await import("./test-connection");
    const ACC = "0123456789abcdef0123456789abcdef";
    const f = fake({
      "/zones?per_page=50": { body: { success: true, result: [{ name: "example.com", account: { id: ACC } }] } },
      [`/accounts/${ACC}/d1/database`]: { status: 403, body: { success: false } },
    });
    const r = await testConnection("cloudflare", "cf-token-for-tests-0000000000000000", { fetch: f.fetch });
    expect(r.ok && r.details).toEqual(["Every permission it needs is there", "No D1 read: add Account → D1 → Read to watch D1 databases (optional)"]);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
});
