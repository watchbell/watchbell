import type { Failure, Result } from "@/lib/providers/http";

// GitHub → Repositories: the repository browser's reads are cached in this instance's memory for a short time (like the
// Dev officer's tree cache), and once GitHub says the rate limit is used up, no call goes out until it resets. Failures
// are not cached (except that pause). Pure apart from the clock it is given.

export const isRateLimit = (f: Failure): boolean => f.retryAfterS !== undefined && (f.status === 403 || f.status === 429);

export const RATE_LIMITED = "GitHub's rate limit is used up for now. Try again later.";

export class TtlCache {
  private rows = new Map<string, { at: number; ttl: number; value: unknown }>();
  private pausedUntil = 0;

  constructor(private max = 200) {}

  // The cached value while fresh; else `load()`, kept when it worked. During a rate-limit pause: a "rate limited" failure.
  async get<T>(key: string, ttlMs: number, load: () => Promise<Result<T>>, now: () => number = Date.now): Promise<Result<T>> {
    const hit = this.rows.get(key);
    if (hit && now() - hit.at < hit.ttl) return { ok: true, data: hit.value as T };
    if (now() < this.pausedUntil) return { ok: false, kind: "transient", status: 429, retryAfterS: Math.ceil((this.pausedUntil - now()) / 1000), error: RATE_LIMITED };
    const r = await load();
    if (r.ok) {
      if (this.rows.size >= this.max) {
        // Drop the oldest entry (Map keeps insertion order).
        const oldest = this.rows.keys().next().value;
        if (oldest !== undefined) this.rows.delete(oldest);
      }
      this.rows.delete(key);
      this.rows.set(key, { at: now(), ttl: ttlMs, value: r.data });
    } else if (isRateLimit(r)) {
      this.pausedUntil = now() + Math.min(3600, Math.max(30, r.retryAfterS ?? 60)) * 1000;
      return { ...r, error: RATE_LIMITED };
    }
    return r;
  }

  clear(): void {
    this.rows.clear();
    this.pausedUntil = 0;
  }
}
