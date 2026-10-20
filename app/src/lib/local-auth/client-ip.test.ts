import { describe, expect, it } from "vitest";
import { selfhostClientIp } from "./client-ip";

const hdrs = (init: Record<string, string>) => new Headers(init);

describe("selfhostClientIp", () => {
  it("is null without WATCHPOST_TRUSTED_PROXY_HOPS, whatever the client sends", () => {
    const h = hdrs({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    expect(selfhostClientIp(h, {})).toBeNull();
    expect(selfhostClientIp(h, { WATCHPOST_TRUSTED_PROXY_HOPS: "" })).toBeNull();
    expect(selfhostClientIp(h, { WATCHPOST_TRUSTED_PROXY_HOPS: "0" })).toBeNull();
    expect(selfhostClientIp(h, { WATCHPOST_TRUSTED_PROXY_HOPS: "-1" })).toBeNull();
    expect(selfhostClientIp(h, { WATCHPOST_TRUSTED_PROXY_HOPS: "one" })).toBeNull();
    expect(selfhostClientIp(h, { WATCHPOST_TRUSTED_PROXY_HOPS: "1.5" })).toBeNull();
  });

  it("with one trusted proxy takes the right-most entry, so a forged left part doesn't count", () => {
    const env = { WATCHPOST_TRUSTED_PROXY_HOPS: "1" };
    expect(selfhostClientIp(hdrs({ "x-forwarded-for": "203.0.113.9" }), env)).toBe("203.0.113.9");
    expect(selfhostClientIp(hdrs({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), env)).toBe("203.0.113.9");
    expect(selfhostClientIp(hdrs({ "x-forwarded-for": " 6.6.6.6 ,203.0.113.9 , " }), env)).toBe("203.0.113.9");
  });

  it("with two trusted proxies takes the second from the right", () => {
    const env = { WATCHPOST_TRUSTED_PROXY_HOPS: "2" };
    expect(selfhostClientIp(hdrs({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }), env)).toBe("203.0.113.9");
  });

  it("is null when the chain is shorter than the hops, or missing; x-real-ip is never used", () => {
    const env = { WATCHPOST_TRUSTED_PROXY_HOPS: "2" };
    expect(selfhostClientIp(hdrs({ "x-forwarded-for": "203.0.113.9" }), env)).toBeNull();
    expect(selfhostClientIp(hdrs({ "x-real-ip": "203.0.113.9" }), { WATCHPOST_TRUSTED_PROXY_HOPS: "1" })).toBeNull();
  });

  it("reads WATCHBELL_TRUSTED_PROXY_HOPS first", () => {
    const h = hdrs({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" });
    expect(selfhostClientIp(h, { WATCHBELL_TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.9");
    expect(selfhostClientIp(h, { WATCHBELL_TRUSTED_PROXY_HOPS: "1", WATCHPOST_TRUSTED_PROXY_HOPS: "2" })).toBe("10.0.0.2");
  });
});
