// Watchbell 1.3 Env check: a Vercel project's environment variable NAMES, read server-side with the app's team id and
// the stored token. GET https://api.vercel.com/v10/projects/{id}/env answers one entry per variable and target set; only
// `key`, `target` and `gitBranch` are read. A `value` the answer may carry (plain or encrypted) is never parsed,
// stored, logged or returned, and `decrypt` is never asked for. Not cached.
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

export type EnvTarget = "production" | "preview" | "development";
export type EnvName = { key: string; targets: EnvTarget[]; branch: string | null };

const TARGETS: readonly EnvTarget[] = ["production", "preview", "development"];
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseEnvNames(raw: unknown): EnvName[] | null {
  const envs = rec(raw)?.envs;
  if (!Array.isArray(envs)) return null;
  const out: EnvName[] = [];
  for (const item of envs) {
    const e = rec(item);
    if (!e || typeof e.key !== "string" || !KEY.test(e.key)) continue;
    const list = Array.isArray(e.target) ? e.target : typeof e.target === "string" ? [e.target] : [];
    const targets = TARGETS.filter((t) => list.includes(t));
    const branch = typeof e.gitBranch === "string" && e.gitBranch.trim() ? e.gitBranch.trim() : null;
    out.push({ key: e.key, targets, branch });
  }
  return out;
}

export async function listEnvNames(token: string, teamId: string, projectId: string, opts: FetchOpts = {}): Promise<Result<EnvName[]>> {
  const q = new URLSearchParams({ teamId });
  const r = await callJson("Vercel", `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?${q}`, { token }, { timeoutMs: 10_000, ...opts });
  if (!r.ok) return r;
  const names = parseEnvNames(r.data);
  return names ? { ok: true, data: names } : formatFailure("Vercel", "the environment variables");
}
