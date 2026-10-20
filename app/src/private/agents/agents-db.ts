import "server-only";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { recordEvents } from "@/lib/data/events-write";
import { aiAgents, aiUsage, apiKeys } from "@/private/db/schema";
import { type AgentStatus, agentStatus } from "./detect";

// Detected callers (R6), server side. Counters come from ai_usage in one grouped query; nothing here stores a prompt,
// an IP or a request body.

export type AgentRow = {
  id: string;
  name: string; // the owner's rename, else the detected client name
  clientName: string; version: string; via: string; userAgent: string;
  keyId: string | null; keyName: string | null; // null = the console itself (no key)
  firstSeenAt: Date; lastSeenAt: Date;
  requests: number; // all time (ai_agents.requests)
  requests24h: number; tokens24h: number; mcpCalls1h: number; mcpCalls24h: number;
  uses: string[]; // "Chat completions", "MCP" (what it called in the last 24 h)
  recent: string[]; // ≤ 10 most recent models or MCP tools
  status: AgentStatus;
};

const MAX_AGENTS = 2000; // R7

export async function listAgents(now: Date): Promise<AgentRow[]> {
  const since24 = new Date(now.getTime() - 86_400_000);
  const since1 = new Date(now.getTime() - 3_600_000).toISOString();
  const [agents, usage] = await Promise.all([
    db().select({
      id: aiAgents.id, displayName: aiAgents.displayName, clientName: aiAgents.clientName, clientVersion: aiAgents.clientVersion, via: aiAgents.via,
      userAgent: aiAgents.userAgent, keyId: aiAgents.keyId, keyName: apiKeys.name, keyRevokedAt: apiKeys.revokedAt,
      firstSeenAt: aiAgents.firstSeenAt, lastSeenAt: aiAgents.lastSeenAt, requests: aiAgents.requests, recent: aiAgents.recent,
    }).from(aiAgents).leftJoin(apiKeys, eq(aiAgents.keyId, apiKeys.id)).orderBy(desc(aiAgents.lastSeenAt)).limit(MAX_AGENTS),
    db().select({
      agentId: aiUsage.agentId,
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(coalesce(${aiUsage.tokensIn}, 0) + coalesce(${aiUsage.tokensOut}, 0)), 0)::float8`,
      mcp1h: sql<number>`(count(*) filter (where ${aiUsage.kind} = 'mcp' and ${aiUsage.at} >= ${since1}::timestamptz))::int`,
      mcp24h: sql<number>`(count(*) filter (where ${aiUsage.kind} = 'mcp'))::int`,
      chat24h: sql<number>`(count(*) filter (where ${aiUsage.kind} = 'chat'))::int`,
    }).from(aiUsage).where(and(isNotNull(aiUsage.agentId), gte(aiUsage.at, since24))).groupBy(aiUsage.agentId),
  ]);
  const byAgent = new Map(usage.map((u) => [u.agentId, u]));
  return agents.map((a) => {
    const u = byAgent.get(a.id);
    const lastSeenAt = new Date(a.lastSeenAt);
    return {
      id: a.id, name: a.displayName ?? a.clientName, clientName: a.clientName, version: a.clientVersion, via: a.via, userAgent: a.userAgent,
      keyId: a.keyId, keyName: a.keyName, firstSeenAt: new Date(a.firstSeenAt), lastSeenAt,
      requests: Number(a.requests), requests24h: Number(u?.requests ?? 0), tokens24h: Number(u?.tokens ?? 0),
      mcpCalls1h: Number(u?.mcp1h ?? 0), mcpCalls24h: Number(u?.mcp24h ?? 0),
      uses: [Number(u?.chat24h ?? 0) > 0 ? "Chat completions" : "", Number(u?.mcp24h ?? 0) > 0 ? "MCP" : ""].filter(Boolean),
      recent: a.recent ?? [], status: agentStatus(lastSeenAt, a.keyRevokedAt !== null && a.keyId !== null, now),
    };
  });
}

async function audit(message: string, by: string): Promise<void> {
  try {
    await recordEvents([{ type: "action", kind: "ok", message, detail: null, resourceId: null, actorUserId: by, reason: "AgentChanged" }]);
  } catch {
    console.warn("agent audit failed");
  }
}

// An empty name clears the rename, so the detected name shows again.
export async function renameAgent(id: string, name: string, by: string): Promise<boolean> {
  const display = name.trim() === "" ? null : name.trim();
  const rows = await db().update(aiAgents).set({ displayName: display }).where(eq(aiAgents.id, id)).returning({ clientName: aiAgents.clientName });
  if (!rows.length) return false;
  await audit(display ? `Agent renamed: ${rows[0].clientName} → ${display}` : `Agent name reset: ${rows[0].clientName}`, by);
  return true;
}

// Forgetting only drops the row; the agent shows up again with its next request. Its usage rows stay for the logs.
export async function forgetAgent(id: string, by: string): Promise<boolean> {
  const rows = await db().delete(aiAgents).where(eq(aiAgents.id, id)).returning({ clientName: aiAgents.clientName });
  if (!rows.length) return false;
  await audit(`Agent forgotten: ${rows[0].clientName}`, by);
  return true;
}

// R7: at most 2,000 agent rows, the ones seen longest ago go first. Runs in the daily job (registry dailySteps).
export async function pruneAgents(): Promise<void> {
  await db().execute(sql`
    delete from ops.ai_agents where id in (select id from ops.ai_agents order by last_seen_at desc offset ${MAX_AGENTS})
  `);
}
