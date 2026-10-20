import "server-only";
import { sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db/client";
import type { ApiKeyContext } from "@/private/auth/api-key";
import type { CallKind, QuotaObservation, UsageRecord } from "@/private/ai/types";

// Call metadata (R5: never prompts or completions). recordCall is the hot path's ONE write after the upstream call,
// run inside after(): one CTE statement that inserts ai_usage, upserts the caller's ai_agents row (requests + 1,
// tokens, `recent` models/tools capped at 10), upserts ai_quota and touches api_keys.last_used_at.

export type CallClient = Omit<ApiKeyContext["client"], "via"> & { via: ApiKeyContext["client"]["via"] | "console" };
export type CallRecord = Omit<UsageRecord, "client"> & { client: CallClient | null };

export const CONSOLE_CLIENT: CallClient = { name: "watchpost-console", version: "5c", via: "console", userAgent: "Watchbell console" };
// The console's own row keeps client_name "watchpost-console" (its conflict key, so its history stays one row); a row
// stored before the Watchbell rename is renamed to "Watchbell console" by its next call.
// Inlined, not a parameter: ON CONFLICT infers the unique index ai_agents_key_client_key only when the expression is
// exactly the index's own (coalesce(key_id, '0000…'::uuid), client_name).
const NO_KEY_SQL = sql.raw("'00000000-0000-0000-0000-000000000000'::uuid");
const RETENTION_DAYS = 30;
const MAX_AGENTS = 2000;

const cut = (s: string, n: number) => s.slice(0, n);

export async function recordCall(rec: CallRecord, quota: QuotaObservation[]): Promise<void> {
  const c = rec.client;
  const item = rec.tool ?? rec.model; // what the agent used: an MCP tool or a model
  const tin = rec.tokensIn ?? 0;
  const tout = rec.tokensOut ?? 0;
  const q = JSON.stringify(quota.map((o) => ({
    provider_id: o.providerId, scope: cut(o.scope, 100), metric: cut(o.metric, 40), used: o.used, limit: o.limit, remaining: o.remaining,
    reset_at: o.resetAt?.toISOString() ?? null, source: o.source,
  })));
  const at = rec.at.toISOString();
  await db().execute(sql`
    with agent as (
      insert into ops.ai_agents as a (key_id, client_name, client_version, via, user_agent, display_name, first_seen_at, last_seen_at, requests, tokens_in, tokens_out, recent)
      select ${rec.keyId}::uuid, ${c ? cut(c.name, 40) : ""}, ${c ? cut(c.version, 24) : ""}, ${c?.via ?? "unknown"}, ${c ? cut(c.userAgent, 200) : ""},
        ${c?.via === "console" ? "Watchbell console" : null}, ${at}::timestamptz, ${at}::timestamptz, 1, ${tin}::bigint, ${tout}::bigint,
        case when ${item}::text is null then '{}'::text[] else array[${item}::text] end
      where ${c !== null}::boolean
      on conflict ((coalesce(key_id, ${NO_KEY_SQL})), client_name) do update set
        client_version = excluded.client_version, via = excluded.via, user_agent = excluded.user_agent,
        display_name = case when excluded.via = 'console' and a.display_name = 'Watchpost console' then excluded.display_name else a.display_name end,
        last_seen_at = greatest(a.last_seen_at, excluded.last_seen_at),
        requests = a.requests + 1, tokens_in = a.tokens_in + excluded.tokens_in, tokens_out = a.tokens_out + excluded.tokens_out,
        recent = case when ${item}::text is null then a.recent else (array[${item}::text] || array_remove(a.recent, ${item}::text))[1:10] end
      returning id
    ), usage as (
      insert into ops.ai_usage (at, key_id, agent_id, provider_id, model, kind, tool, tokens_in, tokens_out, latency_ms, status, error_class, stream, tokens_cached, tokens_thinking)
      values (${at}::timestamptz, ${rec.keyId}::uuid, (select id from agent), ${rec.providerId}::uuid, ${rec.model}, ${rec.kind}, ${rec.tool},
        ${rec.tokensIn}::int, ${rec.tokensOut}::int, ${Math.max(0, Math.round(rec.latencyMs))}, ${rec.status}, ${rec.errorClass}, ${rec.stream},
        ${rec.tokensCached ?? null}::int, ${rec.tokensThinking ?? null}::int)
      returning id
    ), quota as (
      insert into ops.ai_quota as q (provider_id, scope, metric, window_start, used, "limit", remaining, reset_at, source, updated_at)
      select o.provider_id, o.scope, o.metric,
        case when o.source = 'own' then o.reset_at - (case when o.metric like '%:minute' then interval '1 minute' when o.metric like '%:week' then interval '7 days' else interval '1 day' end) end,
        o.used, o."limit", o.remaining, o.reset_at, o.source, now()
      from jsonb_to_recordset(${q}::jsonb) as o(provider_id uuid, scope text, metric text, used int, "limit" int, remaining int, reset_at timestamptz, source text)
      on conflict (provider_id, scope, metric) do update set
        used = case when excluded.source = 'own' and q.source = 'own' and q.window_start = excluded.window_start
          then coalesce(q.used, 0) + coalesce(excluded.used, 0) else excluded.used end,
        window_start = excluded.window_start, "limit" = excluded."limit", remaining = excluded.remaining, reset_at = excluded.reset_at,
        source = excluded.source, updated_at = now()
      returning 1
    ), touch as (
      update ops.api_keys set last_used_at = greatest(coalesce(last_used_at, ${at}::timestamptz), ${at}::timestamptz) where id = ${rec.keyId}::uuid returning 1
    )
    select (select count(*) from usage) as usage, (select count(*) from quota) as quota, (select count(*) from touch) as touched`);
}

// The shared writer for a key's non-AI REST call (/api/v1/me, /status, /status/apps/{app}, /advice): one recordCall
// (usage row + agent upsert + api_keys.last_used_at, no quota) inside after(), so the Agents and Logs pages count these
// calls the same way as AI and MCP calls. `tool` names the endpoint ("status", "status/apps", "advice"). Never throws:
// a failed write only warns. after() outside a request scope throws, and the write then runs right away.
export function recordApiCall(
  key: Pick<ApiKeyContext, "keyId" | "client">, kind: Extract<CallKind, "me" | "status">, tool: string | null, started: number, status: number,
): void {
  const run = () => recordCall({
    at: new Date(started), keyId: key.keyId, client: key.client, providerId: null, model: null, kind, tool, tokensIn: null, tokensOut: null,
    latencyMs: Date.now() - started, status, errorClass: status >= 400 ? `http_${status}` : null, stream: false,
  }, []).catch((e) => { console.warn(`recording /api/v1 ${tool ?? kind} failed:`, e instanceof Error ? e.name : "unknown"); });
  try { after(run); } catch { void run(); }
}

// Daily step (registry T3): usage older than 30 days goes, and agents beyond 2,000 rows go, idle ones first.
export async function pruneUsage(now: Date): Promise<void> {
  const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  await db().execute(sql`
    with old as (delete from ops.ai_usage where at < ${before.toISOString()}::timestamptz returning 1),
    extra as (
      delete from ops.ai_agents where id in (
        select id from ops.ai_agents order by last_seen_at desc offset ${MAX_AGENTS}
      ) returning 1
    )
    select (select count(*) from old) as usage, (select count(*) from extra) as agents`);
}
