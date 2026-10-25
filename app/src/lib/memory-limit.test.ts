import { describe, expect, it } from "vitest";
import { memoryLimiter, negativeCache, requestIp } from "./memory-limit";

// Watchbell 1.2.1 (audit M2): cheap per-instance throttling before a request reaches the database.
describe("memoryLimiter", () => {
  it("allows max hits per window per key, then refuses with the seconds left; a new window starts over", () => {
    const l = memoryLimiter({ max: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect([1, 2, 3].map(() => l.hit("a", t).allowed)).toEqual([true, true, true]);
    expect(l.hit("a", t + 10_000)).toEqual({ allowed: false, retryAfter: 50 });
    expect(l.hit("b", t + 10_000).allowed).toBe(true); // other keys are separate
    expect(l.hit("a", t + 60_000).allowed).toBe(true);
  });

  it("peek doesn't count; count adds without deciding", () => {
    const l = memoryLimiter({ max: 2, windowMs: 60_000 });
    expect(l.peek("a", 0).allowed).toBe(true);
    l.count("a", 0);
    l.count("a", 0);
    expect(l.peek("a", 1).allowed).toBe(false);
    expect(l.peek("a", 60_000).allowed).toBe(true);
  });

  it("keeps memory bounded: past maxKeys the least recently used key is forgotten", () => {
    const l = memoryLimiter({ max: 1, windowMs: 60_000, maxKeys: 2 });
    l.hit("a", 0);
    l.hit("b", 0);
    l.peek("a", 1); // a is used again: b is now the oldest
    l.hit("c", 2);
    expect(l.size()).toBe(2);
    expect(l.hit("b", 3).allowed).toBe(true); // b was forgotten, so it starts over
    expect(l.hit("a", 3).allowed).toBe(true); // a was forgotten when b came back
  });
});

describe("negativeCache", () => {
  it("remembers a key for the ttl, bounded", () => {
    const c = negativeCache({ ttlMs: 60_000, maxKeys: 2 });
    c.add("x", 0);
    expect(c.has("x", 59_999)).toBe(true);
    expect(c.has("x", 60_000)).toBe(false);
    c.add("a", 0);
    c.add("b", 0);
    c.add("c", 0);
    expect(c.has("a", 1)).toBe(false);
    expect(c.has("c", 1)).toBe(true);
    c.delete("c");
    expect(c.has("c", 1)).toBe(false);
  });
});

describe("requestIp", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("cloud: the address Vercel sets; null when there is none", () => {
    expect(requestIp(h({ "x-real-ip": "203.0.113.9" }), { WATCHBELL_MODE: "cloud" })).toBe("203.0.113.9");
    expect(requestIp(h({}), {})).toBeNull();
  });
  it("self-host: only behind a trusted proxy", () => {
    expect(requestIp(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), { WATCHBELL_MODE: "selfhost" })).toBeNull();
    expect(requestIp(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), { WATCHBELL_MODE: "selfhost", WATCHBELL_TRUSTED_PROXY_HOPS: "1" })).toBe("10.0.0.2");
  });
  it("IPv6 counts by its /64", () => {
    expect(requestIp(h({ "x-real-ip": "2001:db8:1:2:3:4:5:6" }), {})).toBe("2001:db8:1:2::/64");
  });
});
