import type { OwnLimitInput } from "@/private/ui/deps-types";

// Validation of the "Limits you enter" form (pure): what an owner may store as their own limit on a provider connection.
export const LIMIT_METRICS = ["requests", "tokens"] as const;
export const LIMIT_WINDOWS = ["minute", "day", "week"] as const;
export const MAX_LIMITS = 10;
const MAX_VALUE = 2_000_000_000; // ai_quota.limit is a 32-bit integer
const SCOPE = /^[A-Za-z0-9._:-]{1,80}$/;

export type LimitsResult = { ok: true; value: OwnLimitInput[] } | { ok: false; error: string };

export function parseLimits(raw: unknown): LimitsResult {
  if (!Array.isArray(raw)) return { ok: false, error: "Something in that request wasn't valid." };
  if (raw.length > MAX_LIMITS) return { ok: false, error: `At most ${MAX_LIMITS} limits per connection.` };
  const out: OwnLimitInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const metric = LIMIT_METRICS.find((m) => m === r.metric);
    const window = LIMIT_WINDOWS.find((w) => w === r.window);
    const scope = typeof r.scope === "string" && r.scope.trim() ? r.scope.trim() : "all";
    const n = typeof r.limit === "string" ? Number(r.limit.replace(/[,_\s]/g, "")) : r.limit;
    if (!metric || !window) return { ok: false, error: "Pick requests or tokens and a window for every limit." };
    if (!SCOPE.test(scope)) return { ok: false, error: "A model name may only use letters, digits and . _ : -." };
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_VALUE) return { ok: false, error: "A limit is a whole number from 1 to 2,000,000,000." };
    const key = `${metric}|${scope}|${window}`;
    if (seen.has(key)) return { ok: false, error: "Two limits are the same metric, model and window." };
    seen.add(key);
    out.push({ metric, scope, limit: n, window });
  }
  return { ok: true, value: out };
}
