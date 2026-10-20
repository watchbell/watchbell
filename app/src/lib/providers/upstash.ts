import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Upstash Developer API (upstash.com/docs/devops/developer-api, checked 16 Oct 2026). HTTP Basic auth: the account
// email as user, a Developer API key as password. Upstash offers "Read Only" keys: use one. Native Upstash accounts only
// (an account made through the Vercel or Fly.io integration can't use this API). Reads only:
//   GET /v2/redis/databases      database_id, database_name, region, primary_region, state, type
//   GET /v2/redis/stats/{id}     daily_net_commands, total_monthly_requests, current_storage, total_monthly_bandwidth
// The database list also carries the endpoint and password: the schema below keeps neither, so they are never stored.
const API = "https://api.upstash.com/v2";
const NAME = "Upstash";

export type UpstashCred = { email: string; apiKey: string };
export type UpstashDb = { id: string; name: string; region: string | null; state: string | null; type: string | null };
export type UpstashStats = { dailyCommands: number | null; monthlyRequests: number | null; storageBytes: number | null; monthlyBandwidthBytes: number | null };

// Stored as one sealed credential: "email:API_KEY". The email never appears on a page or in a log.
export function parseUpstashCred(raw: string): UpstashCred | null {
  const v = raw.trim();
  const at = v.search(/[:\s]/);
  if (at <= 0) return null;
  const email = v.slice(0, at).trim();
  const apiKey = v.slice(at + 1).trim();
  if (!/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/.test(email) || apiKey.length < 20 || /\s/.test(apiKey)) return null;
  return { email, apiKey };
}

const auth = (c: UpstashCred) => ({ basic: { user: c.email, pass: c.apiKey } });

const dbSchema = z.object({
  database_id: z.string(), database_name: z.string(), region: z.string().nullish(), primary_region: z.string().nullish(),
  state: z.string().nullish(), type: z.string().nullish(),
});

export async function listUpstashRedis(cred: UpstashCred, opts: FetchOpts = {}): Promise<Result<UpstashDb[]>> {
  const r = await callJson(NAME, `${API}/redis/databases`, auth(cred), opts);
  if (!r.ok) return r;
  const p = z.array(dbSchema).safeParse(r.data ?? []);
  if (!p.success) return formatFailure(NAME, "the database list");
  return {
    ok: true,
    data: p.data.map((d) => ({
      id: d.database_id, name: d.database_name,
      // "global" databases name their primary region separately.
      region: d.region === "global" && d.primary_region ? `global · ${d.primary_region}` : d.region ?? d.primary_region ?? null,
      state: d.state ?? null, type: d.type ?? null,
    })),
  };
}

const n = z.number().nullish();
const statsSchema = z.object({ daily_net_commands: n, total_monthly_requests: n, current_storage: n, total_monthly_bandwidth: n });

// Pure: the stats answer → the four numbers the console compares with the free plan.
export function parseUpstashStats(body: unknown): Result<UpstashStats> {
  const p = statsSchema.safeParse(body);
  if (!p.success) return formatFailure(NAME, "the database stats");
  return {
    ok: true,
    data: {
      dailyCommands: p.data.daily_net_commands ?? null, monthlyRequests: p.data.total_monthly_requests ?? null,
      storageBytes: p.data.current_storage ?? null, monthlyBandwidthBytes: p.data.total_monthly_bandwidth ?? null,
    },
  };
}

export async function upstashStats(cred: UpstashCred, id: string, opts: FetchOpts = {}): Promise<Result<UpstashStats>> {
  const r = await callJson(NAME, `${API}/redis/stats/${encodeURIComponent(id)}`, auth(cred), opts);
  return r.ok ? parseUpstashStats(r.data) : r;
}
