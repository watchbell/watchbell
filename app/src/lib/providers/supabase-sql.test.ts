import { describe, expect, it, vi } from "vitest";
import { autoAccess, PROBE_QUERY, poolerConfig, runProjectSql } from "./supabase-sql";

const REF = "abcdefghijklmnopqrst";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: unknown };

// A fake fetch answering by path; it records every call. No network.
function fake(answers: { query?: Response | (() => Response); pooler?: Response | (() => Response) }) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const pick = url.endsWith("/database/query") ? answers.query : url.endsWith("/config/database/pooler") ? answers.pooler : undefined;
    if (!pick) return json(404, {});
    return typeof pick === "function" ? pick() : pick.clone();
  });
  return { calls, opts: { fetch: f as unknown as typeof fetch } };
}

describe("runProjectSql", () => {
  it("POSTs the query and the read_only flag to the project's SQL endpoint", async () => {
    const { calls, opts } = fake({ query: json(201, []) });
    expect(await runProjectSql("tok", REF, "select 1", false, opts)).toEqual({ ok: true, data: [] });
    expect(calls).toEqual([{ url: `https://api.supabase.com/v1/projects/${REF}/database/query`, method: "POST", body: { query: "select 1", read_only: false } }]);
  });

  it("reads a 403 as the token's scope (database_write), with or without missing_permissions", async () => {
    expect(await runProjectSql("tok", REF, "select 1", false, fake({ query: json(403, { message: "Forbidden" }) }).opts))
      .toMatchObject({ ok: false, kind: "scope", missing: ["database_write"] });
    expect(await runProjectSql("tok", REF, "select 1", false, fake({ query: json(403, { missing_permissions: ["database_write"] }) }).opts))
      .toMatchObject({ ok: false, kind: "scope", missing: ["database_write"] });
    expect(await runProjectSql("tok", REF, "select 1", false, fake({ query: json(401, {}) }).opts)).toMatchObject({ ok: false, kind: "auth" });
  });

  // Owner 20 Oct: "Supabase returned an error (400)" hid the reason. The Postgres error is shown, but Supabase echoes the
  // statement after "LINE n:", and the setup statement carries the role's SCRAM verifier: neither may reach the page.
  it("shows the Postgres reason of a 400 without the echoed statement, quoted literals or a SCRAM verifier", async () => {
    const message = "Failed to run sql query: ERROR:  42501: permission denied to grant role \"pg_read_all_stats\"\n"
      + "LINE 3:   alter role watchpost_ro with login password 'SCRAM-SHA-256$4096:abc$def:ghi';\n            ^\n";
    const r = await runProjectSql("tok", REF, "do $$ … $$", false, fake({ query: json(400, { message }) }).opts);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (r.ok) throw new Error("expected a failure");
    expect(r.error).toBe("Supabase couldn't run the SQL: 42501: permission denied to grant role \"pg_read_all_stats\"");
    expect(r.error).not.toMatch(/SCRAM|LINE|password/);
    const quoted = await runProjectSql("tok", REF, "x", false, fake({ query: json(400, { message: "ERROR: role 'SCRAM-SHA-256$1:a$b:c' is odd" }) }).opts);
    expect(quoted.ok ? "" : quoted.error).toBe("Supabase couldn't run the SQL: role '…' is odd");
    // 25006 (read-only transaction): the token can only read.
    const ro = await runProjectSql("tok", REF, "x", false, fake({ query: json(400, { message: "Failed to run sql query: ERROR:  25006: cannot execute CREATE ROLE in a read-only transaction" }) }).opts);
    expect(ro).toMatchObject({ ok: false, kind: "scope", missing: ["database_write"], error: "Missing permission: database_write." });
    // No message in the answer: the generic text stays.
    expect(await runProjectSql("tok", REF, "x", false, fake({ query: json(400, {}) }).opts)).toMatchObject({ error: "Supabase returned an error (400)." });
  });
});

describe("poolerConfig", () => {
  it("reads the pooler list", async () => {
    const { calls, opts } = fake({ pooler: json(200, [{ database_type: "PRIMARY", db_host: "aws-0-x.pooler.supabase.com", db_port: 6543, db_user: "postgres.x", db_name: "postgres", pool_mode: "transaction", connection_string: "postgresql://postgres.x:[YOUR-PASSWORD]@h:6543/postgres" }]) });
    const r = await poolerConfig("tok", REF, opts);
    expect(r).toEqual({ ok: true, data: [{ database_type: "PRIMARY", db_host: "aws-0-x.pooler.supabase.com", db_name: "postgres", pool_mode: "transaction" }] });
    expect(calls[0]).toMatchObject({ method: "GET", url: `https://api.supabase.com/v1/projects/${REF}/config/database/pooler` });
  });

  it("reads a 403 as missing database_pooling_config_read, and an odd answer as a format failure", async () => {
    expect(await poolerConfig("tok", REF, fake({ pooler: json(403, {}) }).opts)).toMatchObject({ kind: "scope", missing: ["database_pooling_config_read"] });
    expect(await poolerConfig("tok", REF, fake({ pooler: json(200, { nope: 1 }) }).opts)).toMatchObject({ ok: false, kind: "format" });
  });
});

describe("autoAccess (permission detection)", () => {
  it("can: the probe runs in a writable transaction and the pooler read answers", async () => {
    const { calls, opts } = fake({ query: json(201, [{ read_only: "off" }]), pooler: json(200, []) });
    expect(await autoAccess("tok", REF, opts)).toEqual({ can: true });
    // The probe only reads a setting: it reads no data and changes nothing.
    const probe = calls.find((c) => c.url.endsWith("/database/query"));
    expect(PROBE_QUERY).toBe("select current_setting('transaction_read_only') as read_only");
    expect(probe?.body).toEqual({ query: PROBE_QUERY, read_only: false });
    expect(calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/database/query"))).toEqual([]);
  });

  // Owner 20 Oct: a token with Database: Read only isn't refused; Supabase runs the query as its read-only user, and the
  // setup then failed with 25006 "cannot execute CREATE ROLE in a read-only transaction".
  it("a probe that runs read-only means database_write is missing", async () => {
    expect(await autoAccess("tok", REF, fake({ query: json(201, [{ read_only: "on" }]), pooler: json(200, []) }).opts))
      .toEqual({ can: false, reason: "scope", missing: ["database_write"] });
  });

  it("names every missing permission", async () => {
    expect(await autoAccess("tok", REF, fake({ query: json(403, {}), pooler: json(403, {}) }).opts))
      .toEqual({ can: false, reason: "scope", missing: ["database_write", "database_pooling_config_read"] });
    expect(await autoAccess("tok", REF, fake({ query: json(201, []), pooler: json(403, { missing_permissions: ["database_pooling_config_read"] }) }).opts))
      .toEqual({ can: false, reason: "scope", missing: ["database_pooling_config_read"] });
  });

  it("tells a rejected token and a hiccup apart from a missing permission", async () => {
    expect(await autoAccess("tok", REF, fake({ query: json(401, {}), pooler: json(401, {}) }).opts)).toMatchObject({ can: false, reason: "auth" });
    expect(await autoAccess("tok", REF, fake({ query: json(500, {}), pooler: json(200, []) }).opts)).toMatchObject({ can: false, reason: "other" });
  });
});
