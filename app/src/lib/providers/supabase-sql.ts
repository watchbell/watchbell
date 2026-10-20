import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";
import type { PoolerConfig } from "@/lib/sql/supabase-auto";

// Stage 9 slice 2b: the two Management API calls behind "Set up automatically (read-only)" (spec checked 16 Oct 2026,
// https://api.supabase.com/api/v1-json and https://supabase.com/docs/reference/api/v1-run-a-query):
//   POST /v1/projects/{ref}/database/query          body { query, read_only }  needs Database: Read-write (database_write)
//                                                   for a write; read_only: true only needs database_read
//   GET  /v1/projects/{ref}/config/database/pooler  needs Connection pooling: Read (database_pooling_config_read)
// Only lib/data/sql-auto-db.ts calls these, with the scripts from lib/sql/supabase-auto.ts. Nothing here logs.
const API = "https://api.supabase.com";
const NAME = "Supabase";
const ref = (r: string) => encodeURIComponent(r);

// The permission probe reads one setting: no data, no change. A token with Database: Read only isn't refused by the
// API; Supabase runs the query as its read-only user instead, so the probe asks whether the transaction is read-only
// (owner 20 Oct: the setup then failed with 25006 "cannot execute CREATE ROLE in a read-only transaction").
export const PROBE_QUERY = "select current_setting('transaction_read_only') as read_only";
const READ_ONLY_TX = "25006";
const NO_WRITE = { kind: "scope" as const, missing: ["database_write"], error: "Missing permission: database_write." };

// The rows the query returned (the API answers a JSON array).
export async function runProjectSql(token: string, projectRef: string, query: string, readOnly: boolean, opts: FetchOpts = {}): Promise<Result<unknown>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/database/query`, { method: "POST", token, body: { query, read_only: readOnly } }, { timeoutMs: 10_000, ...opts });
  if (r.ok) return { ok: true, data: r.data };
  // A scoped token without Database read-write answers 403 (with or without missing_permissions): its scope.
  if (r.status === 403 && r.kind !== "scope") return { ...r, ...NO_WRITE };
  // A 400 carries the Postgres error (owner 20 Oct: "returned an error (400)" alone hid it). Never the raw message: see
  // postgresReason.
  if (r.status === 400 && r.message) {
    const reason = postgresReason(r.message);
    if (reason?.startsWith(`${READ_ONLY_TX}:`)) return { ...r, message: undefined, ...NO_WRITE };
    if (reason) return { ...r, message: undefined, error: `${NAME} couldn't run the SQL: ${reason}` };
  }
  return { ...r, message: undefined };
}

// The Management API's message is "Failed to run sql query: ERROR:  <code>: <text>" followed by "LINE n:" and the
// statement itself, which for the automatic setup carries the role's SCRAM verifier. Keep only the first line of the
// error, without the echoed statement, with every quoted literal and any verifier blanked out.
export function postgresReason(message: string): string | null {
  const first = message.split(/\r?\n|\bLINE \d+:/)[0] ?? "";
  const text = first
    .replace(/^.*?\bERROR:\s*/i, "")
    .replace(/'[^']*'/g, "'…'")
    .replace(/SCRAM-SHA-256\$\S+/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 240) : null;
}

const poolerSchema = z.array(z.looseObject({
  database_type: z.string().optional(), db_host: z.string().optional(), db_name: z.string().optional(), pool_mode: z.string().optional(),
}));

export async function poolerConfig(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<PoolerConfig[]>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/config/database/pooler`, { token }, opts);
  if (!r.ok) {
    if (r.status === 403 && r.kind !== "scope") return { ...r, kind: "scope", missing: ["database_pooling_config_read"], error: "Missing permission: database_pooling_config_read." };
    return r;
  }
  const p = poolerSchema.safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the pooler settings");
  return { ok: true, data: p.data.map((c) => ({ database_type: c.database_type, db_host: c.db_host, db_name: c.db_name, pool_mode: c.pool_mode })) };
}

export type AutoAccess =
  | { can: true }
  | { can: false; reason: "scope"; missing: string[] }
  | { can: false; reason: "auth" | "other"; error: string };

export const AUTO_PERMISSIONS = "Database: Read-write and Connection pooling: Read";

// Can this token set the role up? Two read-only calls: the probe on the SQL endpoint with read_only false (the API
// asks for database_write there, or quietly runs it read-only; the statement itself changes nothing) and the pooler
// settings.
export async function autoAccess(token: string, projectRef: string, opts: FetchOpts = {}): Promise<AutoAccess> {
  const [q, p] = await Promise.all([runProjectSql(token, projectRef, PROBE_QUERY, false, opts), poolerConfig(token, projectRef, opts)]);
  const readOnly = q.ok && Array.isArray(q.data) && (q.data[0] as { read_only?: unknown } | undefined)?.read_only === "on";
  const missing = [...new Set([...(readOnly ? ["database_write"] : []), ...[q, p].flatMap((r) => (!r.ok && r.kind === "scope" ? r.missing ?? [] : []))])];
  if (missing.length) return { can: false, reason: "scope", missing };
  const bad = [q, p].find((r) => !r.ok);
  if (bad && !bad.ok) return { can: false, reason: bad.kind === "auth" ? "auth" : "other", error: bad.error };
  return { can: true };
}
