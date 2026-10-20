import { z } from "zod";
import type { CfFailure, CfOpts, CfResult } from "./cloudflare";

// Stage 8: Cloudflare D1, read-only, with the Cloudflare account's existing API token (checked 16 Oct 2026 against
// developers.cloudflare.com/api/resources/d1 and /d1/observability/metrics-analytics):
// - accounts:  GET /accounts (the accounts the token can reach), else the account ids of its zones
// - databases: GET /accounts/{id}/d1/database (permission "Account → D1 → Read"): uuid, name, created_at
// - details:   GET /accounts/{id}/d1/database/{uuid}: file_size (bytes), num_tables (Cloudflare marks it deprecated:
//              "no longer accurate", so the page labels it as approximate)
// - usage:     POST /graphql, dataset d1AnalyticsAdaptiveGroups (permission "Account → Account Analytics → Read"):
//              rowsRead, rowsWritten, readQueries, writeQueries per databaseId and date (UTC days, 31 days kept)
// Nothing here creates, changes or deletes anything; no query ever runs against a D1 database.

const BASE = "https://api.cloudflare.com/client/v4";
export const D1_PERMISSION = "Account → D1 → Read";
export const ANALYTICS_PERMISSION = "Account → Account Analytics → Read";
const MAX_PAGES = 5;

export type D1Database = { uuid: string; name: string; createdAt: string | null; jurisdiction: string | null };
export type D1Details = { sizeBytes: number | null; numTables: number | null; readReplication: string | null };
export type D1Usage = { databaseId: string; rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number };

const id = (v: string) => encodeURIComponent(v);

const envelope = z.object({
  success: z.boolean(), result: z.unknown(),
  result_info: z.object({ total_pages: z.number().optional() }).nullish(),
});
const format = (what: string): CfFailure => ({ ok: false, kind: "format", error: `Cloudflare answered ${what} in a format the console doesn't recognise.` });
const timeoutText = "Cloudflare didn't answer within 5 seconds.";

// GET only, with the same failure wording as cloudflare.ts: a 403 on a call that needs `permission` is a scope gap
// (that permission is missing), not a broken token.
async function get(path: string, token: string, opts: CfOpts, permission: string | null): Promise<CfResult<{ result: unknown; totalPages: number | null }>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}${path}`, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? timeoutText : "Couldn't reach Cloudflare." };
  }
  if (res.status === 403 && permission) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "scope", status: 403, error: `The token can't read this. Add "${permission}" to the Cloudflare token.` };
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "auth", status: res.status, error: `Cloudflare rejected this credential (${res.status}).` };
  }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "transient", status: 429, retryAfterS: 60, error: "Cloudflare says there were too many requests." };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "transient", status: res.status, error: `Cloudflare returned an error (${res.status}).` };
  }
  const body = envelope.safeParse(await res.json().catch(() => null));
  if (!body.success || !body.data.success) return format("its answer");
  return { ok: true, data: { result: body.data.result, totalPages: body.data.result_info?.total_pages ?? null } };
}

export async function listAccounts(token: string, opts: CfOpts = {}): Promise<CfResult<{ id: string; name: string }[]>> {
  const r = await get("/accounts?per_page=50", token, opts, null);
  if (!r.ok) return r;
  const p = z.array(z.object({ id: z.string(), name: z.string().default("") })).safeParse(r.data.result);
  return p.success ? { ok: true, data: p.data } : format("the account list");
}

const dbSchema = z.object({ uuid: z.string(), name: z.string(), created_at: z.string().nullish(), jurisdiction: z.string().nullish() });

export async function listD1(token: string, accountId: string, opts: CfOpts = {}): Promise<CfResult<D1Database[]>> {
  const out: D1Database[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await get(`/accounts/${id(accountId)}/d1/database?per_page=100&page=${page}`, token, opts, D1_PERMISSION);
    if (!r.ok) return r;
    const p = z.array(dbSchema).safeParse(r.data.result);
    if (!p.success) return format("the D1 database list");
    out.push(...p.data.map((d) => ({ uuid: d.uuid, name: d.name, createdAt: d.created_at ?? null, jurisdiction: d.jurisdiction ?? null })));
    if (!r.data.totalPages || page >= r.data.totalPages || p.data.length < 100) break;
  }
  return { ok: true, data: out };
}

const detailSchema = z.object({
  file_size: z.number().nullish(), num_tables: z.number().nullish(),
  read_replication: z.object({ mode: z.string() }).nullish(),
});

export async function getD1(token: string, accountId: string, uuid: string, opts: CfOpts = {}): Promise<CfResult<D1Details>> {
  const r = await get(`/accounts/${id(accountId)}/d1/database/${id(uuid)}`, token, opts, D1_PERMISSION);
  if (!r.ok) return r;
  const p = detailSchema.safeParse(r.data.result);
  if (!p.success) return format("the D1 database");
  return { ok: true, data: { sizeBytes: p.data.file_size ?? null, numTables: p.data.num_tables ?? null, readReplication: p.data.read_replication?.mode ?? null } };
}

// One GraphQL read per account for every database's rows read and written on one UTC day (D1's free quota resets at
// 00:00 UTC). Variables, not string building, carry the account id and the date.
export const D1_USAGE_QUERY = `query D1Usage($accountTag: string!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date: $date }) {
        sum { rowsRead rowsWritten readQueries writeQueries }
        dimensions { databaseId }
      }
    }
  }
}`;

const gqlSchema = z.object({
  data: z.object({
    viewer: z.object({
      accounts: z.array(z.object({
        d1AnalyticsAdaptiveGroups: z.array(z.object({
          sum: z.object({ rowsRead: z.number().default(0), rowsWritten: z.number().default(0), readQueries: z.number().default(0), writeQueries: z.number().default(0) }),
          dimensions: z.object({ databaseId: z.string() }),
        })).default([]),
      })),
    }).nullish(),
  }).nullish(),
  errors: z.array(z.object({ message: z.string().default("") })).nullish(),
});

// Pure: the GraphQL answer → usage per database (summed, in case Cloudflare splits a day). A GraphQL error that says the
// token isn't allowed (Cloudflare answers 200 with `errors`) is a missing permission, not a broken credential.
export function parseD1Usage(body: unknown): CfResult<D1Usage[]> {
  const p = gqlSchema.safeParse(body);
  if (!p.success) return format("the D1 analytics");
  const errors = p.data.errors ?? [];
  if (errors.length) {
    const denied = errors.some((e) => /not authorized|permission|access|authenticat/i.test(e.message));
    return denied
      ? { ok: false, kind: "scope", error: `The token can't read D1 analytics. Add "${ANALYTICS_PERMISSION}" to the Cloudflare token.` }
      : { ok: false, kind: "transient", error: "Cloudflare's analytics answered with an error." };
  }
  const groups = p.data.data?.viewer?.accounts.flatMap((a) => a.d1AnalyticsAdaptiveGroups) ?? [];
  const by = new Map<string, D1Usage>();
  for (const g of groups) {
    const cur = by.get(g.dimensions.databaseId) ?? { databaseId: g.dimensions.databaseId, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
    cur.rowsRead += g.sum.rowsRead;
    cur.rowsWritten += g.sum.rowsWritten;
    cur.readQueries += g.sum.readQueries;
    cur.writeQueries += g.sum.writeQueries;
    by.set(cur.databaseId, cur);
  }
  return { ok: true, data: [...by.values()] };
}

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export async function d1UsageOn(token: string, accountId: string, day: string, opts: CfOpts = {}): Promise<CfResult<D1Usage[]>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query: D1_USAGE_QUERY, variables: { accountTag: accountId, date: day } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? timeoutText : "Couldn't reach Cloudflare." };
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "scope", status: res.status, error: `The token can't read D1 analytics. Add "${ANALYTICS_PERMISSION}" to the Cloudflare token.` };
  }
  if (res.status === 429) return { ok: false, kind: "transient", status: 429, retryAfterS: 60, error: "Cloudflare says there were too many requests." };
  if (!res.ok) return { ok: false, kind: "transient", status: res.status, error: `Cloudflare returned an error (${res.status}).` };
  return parseD1Usage(await res.json().catch(() => null));
}
