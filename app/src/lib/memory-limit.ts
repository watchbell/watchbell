import { clientNetwork } from "@/lib/demo/visitor-limits";
import { selfhostClientIp } from "@/lib/local-auth/client-ip";
import { mode } from "@/lib/mode";

// Watchbell 1.2.1 (audit M2): cheap throttling held in memory, per server instance, checked before a request touches
// the database (the pooler's few client slots are shared with the collector). Vercel may run several instances, so a
// limit here is per instance, not global; it only has to make a flood cost more than it costs us. Memory is bounded:
// past maxKeys the least recently used key is forgotten (it simply starts over). No dependency.

export type MemoryDecision = { allowed: boolean; retryAfter: number };
type Window = { start: number; n: number };

export function memoryLimiter(o: { max: number; windowMs: number; maxKeys?: number }) {
  const maxKeys = o.maxKeys ?? 10_000;
  const keys = new Map<string, Window>();
  const touch = (key: string, now: number): Window => {
    let w = keys.get(key);
    if (w) keys.delete(key); // re-inserted below as the most recently used
    if (!w || now - w.start >= o.windowMs) w = { start: now, n: 0 };
    keys.set(key, w);
    while (keys.size > maxKeys) keys.delete(keys.keys().next().value!);
    return w;
  };
  const decision = (w: Window, now: number, allowed: boolean): MemoryDecision =>
    ({ allowed, retryAfter: Math.max(1, Math.ceil((w.start + o.windowMs - now) / 1000)) });
  return {
    // Counts this request, then decides.
    hit(key: string, now: number = Date.now()): MemoryDecision {
      const w = touch(key, now);
      w.n++;
      return decision(w, now, w.n <= o.max);
    },
    // Decides without counting (a failure is counted afterwards with count()).
    peek(key: string, now: number = Date.now()): MemoryDecision {
      const w = touch(key, now);
      return decision(w, now, w.n < o.max);
    },
    count(key: string, now: number = Date.now()): void {
      touch(key, now).n++;
    },
    size: (): number => keys.size,
    reset: (): void => keys.clear(),
  };
}

// Keys known to be missing (an unknown heartbeat token's hash), remembered for ttlMs, bounded the same way.
export function negativeCache(o: { ttlMs: number; maxKeys?: number }) {
  const maxKeys = o.maxKeys ?? 10_000;
  const keys = new Map<string, number>();
  return {
    has(key: string, now: number = Date.now()): boolean {
      const at = keys.get(key);
      if (at === undefined) return false;
      if (now - at >= o.ttlMs) {
        keys.delete(key);
        return false;
      }
      return true;
    },
    add(key: string, now: number = Date.now()): void {
      keys.delete(key);
      keys.set(key, now);
      while (keys.size > maxKeys) keys.delete(keys.keys().next().value!);
    },
    delete: (key: string): void => void keys.delete(key),
    reset: (): void => keys.clear(),
  };
}

// The caller's network for a per-IP limit, or null when it can't be known (then no per-IP limit applies, so a shared
// bucket never lets one stranger block everyone). Cloud and demo: the address Vercel sets. Self-host: only behind a
// trusted proxy (WATCHBELL_TRUSTED_PROXY_HOPS). IPv6 by its /64.
export function requestIp(headers: Headers, source: Record<string, string | undefined> = process.env): string | null {
  let ip: string | null;
  if (mode(source) === "selfhost") ip = selfhostClientIp(headers, source);
  else ip = headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  return ip ? clientNetwork(ip) : null;
}
