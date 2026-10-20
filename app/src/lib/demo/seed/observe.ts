import { sql } from "drizzle-orm";
import { providerStatus, storedLogs } from "@/db/schema";
import { rowsOf } from "@/db/rows";
import type { SeededApps } from "./apps";
import { ago, HOUR, MINUTE, pgArray, type SeedCtx } from "./context";
import { LOG_LINES } from "./names";
import { rngFor, stableId, stableToken } from "./rng";

// Observe: the Logs page's stored warning/error lines (as the collector copies them from Vercel), the Provider status
// page's feed readings, and the AI Gateway's call metadata (ops.ai_usage, the private feature's table: SQL only, so the
// core seed imports nothing from src/private). No prompts, no completions, no real incidents.

const FEEDS = ["vercel", "supabase", "neon", "cloudflare", "firebase", "gcp"] as const;

export async function seedLogs(ctx: SeedCtx, apps: SeededApps): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "logs");
  const current = rowsOf<{ resource_id: string; external_id: string }>(await db.execute(sql`select resource_id, external_id from ops.deployments where is_current`));
  const noisy = rng.shuffle(apps.apps).slice(0, 3);
  const rows = noisy.flatMap((app, a) => Array.from({ length: rng.int(4, 8) }, (_, i) => {
    const line = rng.pick(LOG_LINES);
    return {
      id: stableId(seed, "log", app.name, i), resourceId: app.id, deploymentId: current.find((d) => d.resource_id === app.id)?.external_id ?? `dpl_${stableToken(24, seed, "log-dpl", a)}`,
      rowId: `${stableToken(10, seed, "log-row", app.name, i).toLowerCase()}-${i}`, at: ago(now, rng.int(3, 46 * 60) * MINUTE + rng.int(0, 59) * 1000),
      level: line.level, message: line.message, requestMethod: line.method, requestPath: line.path, statusCode: line.status, source: "serverless",
    };
  }));
  await db.insert(storedLogs).values(rows);
}

export async function seedProviderStatus(ctx: SeedCtx): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "provider-status");
  const checked = ago(now, rng.int(1, 4) * MINUTE);
  await db.insert(providerStatus).values(FEEDS.map((p) => p === "cloudflare"
    ? {
      provider: p, state: "info" as const, indicator: "maintenance", description: "Scheduled maintenance", checkedAt: checked, lastOkAt: checked, error: null,
      incidents: [{ name: "Scheduled maintenance in one Asia-Pacific data center", impact: "maintenance", startedAt: ago(now, rng.int(1, 3) * HOUR).toISOString(), url: null }],
    }
    : { provider: p, state: "ok" as const, indicator: "none", description: "All Systems Operational", incidents: [], checkedAt: checked, lastOkAt: checked, error: null }));
}

// The console's own AI calls of the last week (Ask AI on an app, the daily summary), one agent row for the console.
export async function seedAiUsage(ctx: SeedCtx): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "ai-usage");
  const agentId = stableId(seed, "ai-agent", "console");
  const n = rng.int(70, 140);
  const at: number[] = [];
  const tokensIn: number[] = [];
  const tokensOut: number[] = [];
  const latency: number[] = [];
  const status: number[] = [];
  const model: number[] = [];
  for (let i = 0; i < n; i++) {
    at.push(now.getTime() - rng.int(2, 7 * 24 * 60) * MINUTE);
    const limited = rng.chance(0.04);
    status.push(limited ? 429 : 200);
    tokensIn.push(limited ? 0 : rng.int(600, 4200));
    tokensOut.push(limited ? 0 : rng.int(80, 700));
    latency.push(limited ? rng.int(80, 300) : rng.int(700, 4800));
    model.push(rng.int(1, 2));
  }
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const last = new Date(Math.max(...at));
  await db.execute(sql`
    insert into ops.ai_agents (id, key_id, client_name, client_version, via, user_agent, first_seen_at, last_seen_at, requests, tokens_in, tokens_out, recent)
    values (${agentId}::uuid, null, 'Watchbell console', '', 'console', 'Watchbell console (ask-ai)', ${ago(now, 30 * 24 * HOUR).toISOString()}::timestamptz,
      ${last.toISOString()}::timestamptz, ${n}, ${sum(tokensIn)}, ${sum(tokensOut)}, ${pgArrayText(["gemini/gemini-2.5-flash", "workers-ai/gemma-3-12b-it"])}::text[])`);
  await db.execute(sql`
    insert into ops.ai_usage (at, key_id, agent_id, provider_id, model, kind, tool, tokens_in, tokens_out, latency_ms, status, error_class, stream)
    select to_timestamp(t.at / 1000.0), null, ${agentId}::uuid, null, (array['gemini/gemini-2.5-flash', 'workers-ai/gemma-3-12b-it'])[t.m], 'console', null,
      case when t.s = 429 then null else t.ti end, case when t.s = 429 then null else t.tout end, t.l, t.s,
      case when t.s = 429 then 'rate_limited · upstream_429' else null end, false
    from unnest(${pgArray(at)}::bigint[], ${pgArray(model)}::int[], ${pgArray(tokensIn)}::int[], ${pgArray(tokensOut)}::int[], ${pgArray(latency)}::int[],
      ${pgArray(status)}::int[]) as t(at, m, ti, tout, l, s)
    order by t.at`);
}

// A Postgres text[] literal for two fixed, quote-free strings.
const pgArrayText = (xs: string[]) => `{${xs.join(",")}}`;
