import { memoryLimiter, negativeCache } from "@/lib/memory-limit";

// Watchbell 1.2.1 (audit M2): /api/ping/* is public, and an unknown token used to cost a database read every time.
// Before the database: the token's format (parsePing), a one-minute memory of unknown tokens (by hash), a per-IP limit
// on all pings, and a per-IP limit on DISTINCT unknown tokens (an IP that keeps guessing new tokens is refused for the
// window; a stale cron job that keeps pinging the same deleted token counts once, so its live heartbeats go on). Per server
// instance; on globalThis so a dev-server reload keeps the counts.
export const PING_PER_IP = { max: 120, windowMs: 60_000 } as const;
export const PING_MISSES_PER_IP = { max: 20, windowMs: 10 * 60_000 } as const;
export const UNKNOWN_TTL_MS = 60_000;

type Throttle = {
  ip: ReturnType<typeof memoryLimiter>; misses: ReturnType<typeof memoryLimiter>; unknown: ReturnType<typeof negativeCache>;
  seenMiss: ReturnType<typeof negativeCache>; miss: (ip: string, hash: string) => void; reset: () => void;
};
export const pingThrottle: Throttle = ((globalThis as { __watchbellPingThrottle?: Throttle }).__watchbellPingThrottle ??= (() => {
  const t = {
    ip: memoryLimiter(PING_PER_IP), misses: memoryLimiter(PING_MISSES_PER_IP), unknown: negativeCache({ ttlMs: UNKNOWN_TTL_MS }),
    seenMiss: negativeCache({ ttlMs: PING_MISSES_PER_IP.windowMs, maxKeys: 50_000 }),
  };
  // Review I3: only a token this IP hasn't missed with in the window counts.
  const miss = (ip: string, hash: string) => {
    const key = `${ip} ${hash}`;
    if (t.seenMiss.has(key)) return;
    t.seenMiss.add(key);
    t.misses.count(ip);
  };
  return { ...t, miss, reset: () => { t.ip.reset(); t.misses.reset(); t.unknown.reset(); t.seenMiss.reset(); } };
})());
