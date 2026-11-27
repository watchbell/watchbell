import { memoryLimiter, negativeCache } from "@/lib/memory-limit";
import { PING_MISSES_PER_IP, PING_PER_IP, UNKNOWN_TTL_MS } from "@/lib/ping-throttle";

// Watchbell 1.8.6: /api/alertmanager/{token} is public like /api/ping, so it gets the same guard before the database
// (lib/ping-throttle.ts): a per-IP limit, an IP that keeps sending unknown tokens is refused for a while, and an unknown
// token is remembered for a minute. Its own counters (a ping flood doesn't block Alertmanager, nor the other way round).
type Throttle = {
  ip: ReturnType<typeof memoryLimiter>; misses: ReturnType<typeof memoryLimiter>; unknown: ReturnType<typeof negativeCache>;
  seenMiss: ReturnType<typeof negativeCache>; miss: (ip: string, hash: string) => void; reset: () => void;
};
export const ingestThrottle: Throttle = ((globalThis as { __watchbellIngestThrottle?: Throttle }).__watchbellIngestThrottle ??= (() => {
  const t = {
    ip: memoryLimiter(PING_PER_IP), misses: memoryLimiter(PING_MISSES_PER_IP), unknown: negativeCache({ ttlMs: UNKNOWN_TTL_MS }),
    seenMiss: negativeCache({ ttlMs: PING_MISSES_PER_IP.windowMs, maxKeys: 50_000 }),
  };
  const miss = (ip: string, hash: string) => {
    const key = `${ip} ${hash}`;
    if (t.seenMiss.has(key)) return;
    t.seenMiss.add(key);
    t.misses.count(ip);
  };
  return { ...t, miss, reset: () => { t.ip.reset(); t.misses.reset(); t.unknown.reset(); t.seenMiss.reset(); } };
})());
