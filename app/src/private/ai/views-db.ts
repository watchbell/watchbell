import "server-only";
import type { ModelTest } from "@/private/ai/providers/routing";
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { wibDay, wibDayStart } from "@/lib/view/uptime";
import { AI_DEFAULT_MODEL_SETTING, type CallKind } from "@/private/ai/types";
import { aiAgents, aiProviders, aiUsage, apiKeys } from "@/private/db/schema";
import { providerSlug } from "@/private/ui/slug";

// Reads for the AI Gateway pages (Task 4). Owner pages only; callers are server components and actions that already
// passed the owner gate. Metadata only (R5): ai_usage has no prompt or completion column, and nothing here adds one.

export const LOG_PAGE_SIZE = 50;
export const LOG_MAX_PAGE_SIZE = 100;
export const EXPORT_MAX_ROWS = 5000;
const MAX_PAGE = 2000;
const HOUR = 3_600_000;

export const DEFAULT_MODEL_SETTING = AI_DEFAULT_MODEL_SETTING;

export type LogStatus = "ok" | "limit" | "error";
export type LogFilter = { keyId?: string; status?: LogStatus; client?: string; model?: string; kind?: CallKind };

export type LogRow = {
  id: number; at: Date; keyName: string | null; client: string | null; model: string | null; kind: string; tool: string | null;
  tokensIn: number | null; tokensOut: number | null; latencyMs: number; status: number; errorClass: string | null; stream: boolean;
};
export type LogPage = { rows: LogRow[]; page: number; pageSize: number; hasMore: boolean };

// The only columns a log query may select. There is no prompt column in ai_usage; the test pins this list.
export const LOG_COLUMNS = ["id", "at", "keyName", "clientName", "clientVersion", "model", "kind", "tool", "tokensIn", "tokensOut", "latencyMs", "status", "errorClass", "stream"] as const;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function logWhere(f: LogFilter) {
  const w = [];
  if (f.keyId) w.push(eq(aiUsage.keyId, f.keyId));
  if (f.status === "ok") w.push(gte(aiUsage.status, 200), lt(aiUsage.status, 400));
  if (f.status === "limit") w.push(eq(aiUsage.status, 429));
  if (f.status === "error") w.push(gte(aiUsage.status, 400), ne(aiUsage.status, 429));
  if (f.kind) w.push(eq(aiUsage.kind, f.kind));
  if (f.client?.trim()) w.push(ilike(aiAgents.clientName, `%${likeEscape(f.client.trim().slice(0, 60))}%`));
  if (f.model?.trim()) w.push(or(ilike(aiUsage.model, `%${likeEscape(f.model.trim().slice(0, 80))}%`), ilike(aiUsage.tool, `%${likeEscape(f.model.trim().slice(0, 80))}%`)));
  return w.length ? and(...w) : undefined;
}

async function readLog(filter: LogFilter, page: number, pageSize: number, cap: number): Promise<LogPage> {
  const size = Math.min(Math.max(1, Math.floor(pageSize) || LOG_PAGE_SIZE), cap);
  const p = Math.min(Math.max(1, Math.floor(page) || 1), MAX_PAGE);
  const rows = await db()
    .select({
      id: aiUsage.id, at: aiUsage.at, keyName: apiKeys.name, clientName: aiAgents.clientName, clientVersion: aiAgents.clientVersion,
      model: aiUsage.model, kind: aiUsage.kind, tool: aiUsage.tool, tokensIn: aiUsage.tokensIn, tokensOut: aiUsage.tokensOut,
      latencyMs: aiUsage.latencyMs, status: aiUsage.status, errorClass: aiUsage.errorClass, stream: aiUsage.stream,
    })
    .from(aiUsage)
    .leftJoin(apiKeys, eq(apiKeys.id, aiUsage.keyId))
    .leftJoin(aiAgents, eq(aiAgents.id, aiUsage.agentId))
    .where(logWhere(filter))
    .orderBy(desc(aiUsage.at), desc(aiUsage.id))
    .limit(size + 1)
    .offset((p - 1) * size);
  return {
    rows: rows.slice(0, size).map((r) => ({
      id: r.id, at: r.at, keyName: r.keyName, client: r.clientName ? (r.clientVersion ? `${r.clientName}/${r.clientVersion}` : r.clientName) : null,
      model: r.model, kind: r.kind, tool: r.tool, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: r.latencyMs, status: r.status,
      errorClass: r.errorClass, stream: r.stream,
    })),
    page: p, pageSize: size, hasMore: rows.length > size,
  };
}

// One page of the log, newest first. The page size is capped at 100.
export function usageLog(filter: LogFilter, page: number, pageSize: number = LOG_PAGE_SIZE): Promise<LogPage> {
  return readLog(filter, page, pageSize, LOG_MAX_PAGE_SIZE);
}

// The CSV export reads the same columns, up to 5,000 rows, in one go.
export async function usageExport(filter: LogFilter): Promise<LogRow[]> {
  return (await readLog(filter, 1, EXPORT_MAX_ROWS, EXPORT_MAX_ROWS)).rows;
}

export async function keyOptions(): Promise<{ id: string; name: string }[]> {
  return db().select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).orderBy(asc(apiKeys.name)).limit(100);
}

export type OverviewCounts = {
  providers: { name: string; kind: string; enabled: boolean; isDefault: boolean; lastTestStatus: number | null }[];
  keys: { active: number; revoked: number; neverUsed: number };
  today: { requests: number; rateLimited: number; refused: number };
  agents: { active24h: number; names: string[] };
};

// The four Overview tiles. "Today" is the WIB day, like every other day count in the console.
export async function overviewCounts(now: Date): Promise<OverviewCounts> {
  const dayStart = wibDayStart(wibDay(now));
  const since = new Date(now.getTime() - 24 * HOUR);
  const [providers, keyRows, usage, agents] = await Promise.all([
    db().select({ name: aiProviders.name, kind: aiProviders.kind, enabled: aiProviders.enabled, isDefault: aiProviders.isDefault, lastTestStatus: aiProviders.lastTestStatus }).from(aiProviders).orderBy(desc(aiProviders.isDefault), asc(aiProviders.name)),
    db().select({ revokedAt: apiKeys.revokedAt, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys),
    db().select({
      requests: count(),
      rateLimited: sql<number>`count(*) filter (where ${aiUsage.status} = 429)`.mapWith(Number),
      refused: sql<number>`count(*) filter (where ${aiUsage.status} in (401, 403))`.mapWith(Number),
    }).from(aiUsage).where(gte(aiUsage.at, dayStart)),
    db().select({ clientName: aiAgents.clientName, lastSeenAt: aiAgents.lastSeenAt }).from(aiAgents).where(gte(aiAgents.lastSeenAt, since)).orderBy(desc(aiAgents.lastSeenAt)).limit(50),
  ]);
  const live = keyRows.filter((k) => !k.revokedAt && !(k.expiresAt && k.expiresAt <= now));
  const u = usage[0] ?? { requests: 0, rateLimited: 0, refused: 0 };
  return {
    providers,
    keys: { active: live.length, revoked: keyRows.filter((k) => k.revokedAt).length, neverUsed: live.filter((k) => !k.lastUsedAt).length },
    today: { requests: Number(u.requests), rateLimited: Number(u.rateLimited), refused: Number(u.refused) },
    agents: { active24h: new Set(agents.map((a) => a.clientName)).size, names: [...new Set(agents.map((a) => a.clientName))].slice(0, 6) },
  };
}

// The "No provider connected" banner: true when at least one provider connection is enabled.
export async function hasEnabledProvider(): Promise<boolean> {
  const [row] = await db().select({ n: count() }).from(aiProviders).where(eq(aiProviders.enabled, true));
  return Number(row?.n ?? 0) > 0;
}

export type LimitProvider = { id: string; name: string; limits: { metric: string; scope: string; limit: number; window: "minute" | "day" | "week" }[] };

// The enabled connections with their own limits, for the "Limits you enter" editor (the quota maths itself is Task 3's quotaRows).
export async function limitProviders(): Promise<LimitProvider[]> {
  return db().select({ id: aiProviders.id, name: aiProviders.name, limits: aiProviders.limits }).from(aiProviders).where(eq(aiProviders.enabled, true)).orderBy(asc(aiProviders.name));
}

export type KeyUsageRow = { id: string; name: string; ratePerMin: number; lastMinute: number; today: number; lastUsedAt: Date | null };

// Per-key table on Quota: the key's limit, calls in the last 60 s and calls today (WIB), from ai_usage in one grouped query.
export async function keyUsage(now: Date): Promise<KeyUsageRow[]> {
  const dayStart = wibDayStart(wibDay(now));
  const minuteAgo = new Date(now.getTime() - 60_000);
  const [keys, usage] = await Promise.all([
    db().select({ id: apiKeys.id, name: apiKeys.name, ratePerMin: apiKeys.ratePerMin, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(isNull(apiKeys.revokedAt)).orderBy(asc(apiKeys.name)).limit(100),
    db().select({
      keyId: aiUsage.keyId,
      today: count(),
      lastMinute: sql<number>`count(*) filter (where ${aiUsage.at} >= ${minuteAgo.toISOString()}::timestamptz)`.mapWith(Number),
    }).from(aiUsage).where(and(gte(aiUsage.at, dayStart), isNotNull(aiUsage.keyId))).groupBy(aiUsage.keyId),
  ]);
  const by = new Map(usage.map((r) => [r.keyId, r]));
  return keys
    .filter((k) => !(k.expiresAt && k.expiresAt <= now))
    .map((k) => ({ id: k.id, name: k.name, ratePerMin: k.ratePerMin, lastMinute: Number(by.get(k.id)?.lastMinute ?? 0), today: Number(by.get(k.id)?.today ?? 0), lastUsedAt: k.lastUsedAt }));
}

export type ModelRow = {
  providerId: string; providerKind: string; providerName: string; providerEnabled: boolean;
  modelId: string; publicId: string; upstream: string; enabled: boolean; ctx: number | null; out: number | null; manual: boolean;
  lastTest: ModelTest | null; // Models › Test / Scan all (owner 14 Oct)
  removed: boolean; pending: boolean; addedAt: string | null; manualOff: boolean; // model sync (owner 16 Oct)
};

// Every model of every connection, with its public id `provider/model` (a bare id goes to the default provider).
export async function modelRows(): Promise<{ rows: ModelRow[]; defaultModel: string | null; providers: { id: string; kind: string; name: string; enabled: boolean }[] }> {
  const [provs, [def]] = await Promise.all([
    db().select({ id: aiProviders.id, kind: aiProviders.kind, name: aiProviders.name, enabled: aiProviders.enabled, models: aiProviders.models }).from(aiProviders).orderBy(desc(aiProviders.isDefault), asc(aiProviders.name)),
    db().select({ value: settings.value }).from(settings).where(eq(settings.key, DEFAULT_MODEL_SETTING)).limit(1),
  ]);
  const rows = provs.flatMap((p) => p.models.map((m) => ({
    providerId: p.id, providerKind: p.kind, providerName: p.name, providerEnabled: p.enabled,
    modelId: m.id, publicId: `${providerSlug(p.kind, p.name)}/${m.id}`, upstream: m.upstream, enabled: m.enabled, ctx: m.ctx ?? null, out: m.out ?? null, manual: m.manual === true, lastTest: m.lastTest ?? null,
    removed: m.removed === true, pending: m.pending === true, addedAt: m.addedAt ?? null, manualOff: m.manualOff === true,
  })));
  return { rows, defaultModel: typeof def?.value === "string" ? def.value : null, providers: provs.map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled })) };
}

export async function setDefaultModel(publicId: string, now: Date): Promise<void> {
  await db().insert(settings).values({ key: DEFAULT_MODEL_SETTING, value: publicId })
    .onConflictDoUpdate({ target: settings.key, set: { value: publicId, updatedAt: now } });
}

export type McpAgentRow = { clientName: string; clientVersion: string; lastSeenAt: Date; keyName: string | null };

// Agents seen over MCP in the last 24 h (the Connect page's "waiting for an agent" row).
export async function mcpAgentsSeen(now: Date): Promise<McpAgentRow[]> {
  const since = new Date(now.getTime() - 24 * HOUR);
  return db()
    .select({ clientName: aiAgents.clientName, clientVersion: aiAgents.clientVersion, lastSeenAt: aiAgents.lastSeenAt, keyName: apiKeys.name })
    .from(aiAgents).leftJoin(apiKeys, eq(apiKeys.id, aiAgents.keyId))
    .where(and(eq(aiAgents.via, "mcp"), gte(aiAgents.lastSeenAt, since), or(isNull(apiKeys.revokedAt), isNull(aiAgents.keyId))))
    .orderBy(desc(aiAgents.lastSeenAt)).limit(5);
}

