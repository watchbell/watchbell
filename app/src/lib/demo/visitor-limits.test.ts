import { describe, expect, it } from "vitest";
import { clientNetwork, DEMO_LIMIT_WINDOW_MS, demoClientKey, SHARED_CLIENT, windowLimiter } from "./visitor-limits";

const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff, "x-real-ip": "10.9.9.9" });

describe("demoClientKey", () => {
  it("on Vercel: the left-most x-forwarded-for address (Vercel sets the header itself)", () => {
    expect(demoClientKey(h("198.51.100.7"), { VERCEL: "1" })).toBe("ip:198.51.100.7");
    expect(demoClientKey(h(" 198.51.100.7 , 10.0.0.1"), { VERCEL: "1" })).toBe("ip:198.51.100.7");
    expect(demoClientKey(h(), { VERCEL: "1" })).toBe("ip:unknown");
  });

  it("buckets IPv6 by its /64 so one host can't rotate addresses past the limit", () => {
    expect(demoClientKey(h("2001:db8:1:2::abcd"), { VERCEL: "1" })).toBe("ip:2001:db8:1:2::/64");
    expect(demoClientKey(h("2001:db8:1:2:ffff:1:2:3"), { VERCEL: "1" })).toBe("ip:2001:db8:1:2::/64");
    expect(clientNetwork("2001:0db8:0000:0002:0:0:0:1")).toBe("2001:db8:0:2::/64");
    expect(clientNetwork("::1")).toBe("0:0:0:0::/64");
    expect(clientNetwork("::ffff:198.51.100.7")).toBe("::ffff:198.51.100.7");
    expect(clientNetwork("198.51.100.7")).toBe("198.51.100.7");
    expect(clientNetwork("not:an:ip")).toBe("not:an:ip");
  });

  it("anywhere else no header is trusted: everyone shares one bucket", () => {
    for (const source of [{}, { VERCEL: "" }, { VERCEL: "0" }]) {
      expect(demoClientKey(h("198.51.100.7"), source)).toBe(SHARED_CLIENT);
      expect(demoClientKey(h(), source)).toBe(SHARED_CLIENT);
    }
  });
});

describe("windowLimiter", () => {
  const T = Date.UTC(2026, 9, 19, 12);

  it("allows `perClient` distinct ids per client per window, each client on its own", () => {
    const l = windowLimiter({ perClient: 3, shared: 10 });
    for (const id of ["a", "b", "c"]) expect(l.take("ip:1", id, T)).toBe(true);
    expect(l.take("ip:1", "d", T)).toBe(false);
    expect(l.take("ip:2", "d", T)).toBe(true);
  });

  it("counts the same id once within the window (a re-created seed is not a new one)", () => {
    const l = windowLimiter({ perClient: 2, shared: 10 });
    expect(l.take("ip:1", "a", T)).toBe(true);
    for (let i = 0; i < 5; i++) expect(l.take("ip:1", "a", T + i)).toBe(true);
    expect(l.take("ip:1", "b", T)).toBe(true);
    expect(l.take("ip:1", "c", T)).toBe(false);
  });

  it("slides: an id counted a full window ago no longer counts", () => {
    const l = windowLimiter({ perClient: 2, shared: 10 });
    expect(l.take("ip:1", "a", T)).toBe(true);
    expect(l.take("ip:1", "b", T + 60_000)).toBe(true);
    expect(l.take("ip:1", "c", T + DEMO_LIMIT_WINDOW_MS - 1)).toBe(false);
    expect(l.take("ip:1", "c", T + DEMO_LIMIT_WINDOW_MS)).toBe(true); // "a" has expired
    expect(l.take("ip:1", "d", T + DEMO_LIMIT_WINDOW_MS)).toBe(false); // "b" hasn't
  });

  it("the shared bucket gets the larger limit", () => {
    const l = windowLimiter({ perClient: 1, shared: 4 });
    for (const id of ["a", "b", "c", "d"]) expect(l.take(SHARED_CLIENT, id, T)).toBe(true);
    expect(l.take(SHARED_CLIENT, "e", T)).toBe(false);
  });

  it("forgets everything on reset", () => {
    const l = windowLimiter({ perClient: 1, shared: 1 });
    l.take("ip:1", "a", T);
    expect(l.take("ip:1", "b", T)).toBe(false);
    l.reset();
    expect(l.take("ip:1", "b", T)).toBe(true);
  });
});
