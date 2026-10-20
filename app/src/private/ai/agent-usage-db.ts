import "server-only";
import { and, desc, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { settings } from "@/db/schema";
import { aiAgents, aiProviders, aiUsage } from "@/private/db/schema";
import {
  AG_ACTIVITY_SETTING, AG_LIMITS_SETTING, type AgActivity, type AgentTokenRow, type AgLimits, parseActivity, parseLimits,
} from "./agent-usage";
import { recordCall, type CallRecord } from "./usage";

// Storage for Antigravity's runs (MCP report_usage → ai_usage rows of kind 'agent' through the shared recordCall, so
// the caller's ai_agents row and api_keys.last_used_at move too), what runs now (report_activity → ops.settings
// antigravity.activity) and the owner's quota estimates (antigravity.limits). Both MCP writes count the key's hourly
// budget in ops.rate_limits first, like report_models.

export const USAGE_REPORTS_PER_HOUR = 120; // the VM reports after each run (asks, pings, the twice-daily advisor)
export const ACTIVITY_REPORTS_PER_HOUR = 240; // one at the start and one at the end of every run

type Row = Record<string, unknown>;
const hourStart = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
const retryAfter = (now: Date) => Math.ceil((Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000 - now.getTime()) / 1000);

export type Limited = { ok: false; reason: "rate_limited"; retryAfter: number };

async function hit(name: string, keyId: string, max: number, now: Date): Promise<boolean> {
  const res = await db().execute(sql`
    insert into ops.rate_limits (key, window_start, count) values (${`${name}:${keyId}`}, ${hourStart(now)}::timestamptz, 1)
    on conflict (key, window_start) do update set count = ops.rate_limits.count + 1
    returning count`);
  return Number(rowsOf<Row>(res)[0]?.count ?? Infinity) <= max;
}

// One budget hit for the whole report, then one recordCall per run (≤ 20).
export async function recordRuns(records: CallRecord[], keyId: string, now: Date = new Date()): Promise<{ ok: true; recorded: number } | Limited> {
  if (!(await hit("ai-usage", keyId, USAGE_REPORTS_PER_HOUR, now))) return { ok: false, reason: "rate_limited", retryAfter: retryAfter(now) };
  for (const rec of records) await recordCall(rec, []);
  return { ok: true, recorded: records.length };
}

// Replaces the value in ONE statement that also counts the key's hourly budget.
export async function saveActivity(activity: AgActivity, keyId: string, now: Date = new Date()): Promise<{ ok: true } | Limited> {
  const at = now.toISOString();
  const res = await db().execute(sql`
    with hit as (
      insert into ops.rate_limits (key, window_start, count) values (${`ai-activity:${keyId}`}, ${hourStart(now)}::timestamptz, 1)
      on conflict (key, window_start) do update set count = ops.rate_limits.count + 1
      returning count
    ), up as (
      insert into ops.settings (key, value, created_at, updated_at)
      select ${AG_ACTIVITY_SETTING}, ${JSON.stringify(activity)}::jsonb, ${at}::timestamptz, ${at}::timestamptz
      from hit where hit.count <= ${ACTIVITY_REPORTS_PER_HOUR}
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      returning 1
    )
    select (select count from hit) as hits, (select count(*) from up)::int as saved`);
  return Number(rowsOf<Row>(res)[0]?.saved) === 1 ? { ok: true } : { ok: false, reason: "rate_limited", retryAfter: retryAfter(now) };
}

export async function saveLimits(limits: AgLimits, now: Date = new Date()): Promise<void> {
  const value = { ...limits };
  await db().insert(settings).values({ key: AG_LIMITS_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

// ---- Reads for AI › Usage ----

export async function readUsageSettings(now: Date): Promise<{ activity: AgActivity | null; limits: AgLimits }> {
  const rows = await db().select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [AG_ACTIVITY_SETTING, AG_LIMITS_SETTING]));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  return { activity: parseActivity(v(AG_ACTIVITY_SETTING), now), limits: parseLimits(v(AG_LIMITS_SETTING)) };
}

const ROWS_CAP = 20_000;
const cols = {
  at: aiUsage.at, kind: aiUsage.kind, model: aiUsage.model, tool: aiUsage.tool, providerId: aiUsage.providerId, agentId: aiUsage.agentId,
  tokensIn: aiUsage.tokensIn, tokensCached: aiUsage.tokensCached, tokensOut: aiUsage.tokensOut, tokensThinking: aiUsage.tokensThinking,
  latencyMs: aiUsage.latencyMs, status: aiUsage.status,
};
export type UsageDbRow = { at: Date; kind: string; model: string | null; tool: string | null; providerId: string | null; agentId: string | null;
  tokensIn: number | null; tokensCached: number | null; tokensOut: number | null; tokensThinking: number | null; latencyMs: number; status: number };

// Model work (agent, chat, console) since `since`, newest first, at most 20,000 rows (`capped` says so).
export async function modelRowsSince(since: Date): Promise<{ rows: UsageDbRow[]; capped: boolean }> {
  const rows = await db().select(cols).from(aiUsage)
    .where(and(gte(aiUsage.at, since), inArray(aiUsage.kind, ["agent", "chat", "console"]))).orderBy(desc(aiUsage.at)).limit(ROWS_CAP + 1);
  return { rows: rows.slice(0, ROWS_CAP), capped: rows.length > ROWS_CAP };
}

export async function recentRows(kinds: string[], n = 50): Promise<UsageDbRow[]> {
  return db().select(cols).from(aiUsage).where(inArray(aiUsage.kind, kinds)).orderBy(desc(aiUsage.at)).limit(n);
}

// Agent rows of the last 7 days (the quota bars' widest window).
export async function agentWeekRows(now: Date): Promise<AgentTokenRow[]> {
  return db().select({ at: aiUsage.at, model: aiUsage.model, tokensIn: aiUsage.tokensIn, tokensCached: aiUsage.tokensCached, tokensOut: aiUsage.tokensOut, tokensThinking: aiUsage.tokensThinking })
    .from(aiUsage).where(and(gte(aiUsage.at, new Date(now.getTime() - 7 * 86_400_000)), inArray(aiUsage.kind, ["agent"]))).limit(ROWS_CAP);
}

// Requests per caller (any kind) since `since`, for the graph's MCP client nodes.
export async function requestsByAgent(since: Date): Promise<Map<string, number>> {
  const rows = await db().select({ agentId: aiUsage.agentId, n: sql<number>`count(*)::int` }).from(aiUsage).where(gte(aiUsage.at, since)).groupBy(aiUsage.agentId);
  return new Map(rows.filter((r) => r.agentId).map((r) => [r.agentId as string, Number(r.n)]));
}

export async function providerList(): Promise<{ id: string; name: string; kind: string; enabled: boolean }[]> {
  return db().select({ id: aiProviders.id, name: aiProviders.name, kind: aiProviders.kind, enabled: aiProviders.enabled }).from(aiProviders).limit(50);
}

// MCP clients seen in the last 7 days.
export async function mcpClients(now: Date): Promise<{ id: string; name: string; displayName: string | null; lastSeenAt: Date }[]> {
  return db().select({ id: aiAgents.id, name: aiAgents.clientName, displayName: aiAgents.displayName, lastSeenAt: aiAgents.lastSeenAt }).from(aiAgents)
    .where(and(gte(aiAgents.lastSeenAt, new Date(now.getTime() - 7 * 86_400_000)), inArray(aiAgents.via, ["mcp"]))).orderBy(desc(aiAgents.lastSeenAt)).limit(12);
}

// AI › Quota "Provider usage": model work of the last 7 days (chat, console, models, agent), at most 20,000 rows.
export async function providerUsageRows(now: Date): Promise<{ at: Date; kind: string; providerId: string | null; tokensIn: number | null;
  tokensCached: number | null; tokensOut: number | null; tokensThinking: number | null; status: number }[]> {
  return db().select({
    at: aiUsage.at, kind: aiUsage.kind, providerId: aiUsage.providerId, tokensIn: aiUsage.tokensIn, tokensCached: aiUsage.tokensCached,
    tokensOut: aiUsage.tokensOut, tokensThinking: aiUsage.tokensThinking, status: aiUsage.status,
  }).from(aiUsage)
    .where(and(gte(aiUsage.at, new Date(now.getTime() - 7 * 86_400_000)), inArray(aiUsage.kind, ["chat", "console", "models", "agent"]))).limit(ROWS_CAP);
}
