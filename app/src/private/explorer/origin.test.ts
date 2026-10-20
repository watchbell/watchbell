import { describe, expect, it } from "vitest";
import { originFrom } from "./origin";

const h = (o: Record<string, string>) => new Headers(o);

describe("originFrom", () => {
  it("uses the forwarded host and protocol first", () => {
    expect(originFrom(h({ "x-forwarded-host": "watch.example.com", "x-forwarded-proto": "https", host: "internal:3000" }), "https://fallback.example")).toBe("https://watch.example.com");
  });
  it("uses http for localhost and https for anything else when no protocol is forwarded", () => {
    expect(originFrom(h({ host: "localhost:3100" }), "https://x.example")).toBe("http://localhost:3100");
    expect(originFrom(h({ host: "watch.example.com" }), "https://x.example")).toBe("https://watch.example.com");
  });
  it("takes the first of a comma-separated list", () => {
    expect(originFrom(h({ "x-forwarded-host": "a.example.com, b.example.com", "x-forwarded-proto": "https, http" }), "https://x.example")).toBe("https://a.example.com");
  });
  it("falls back (without a trailing slash) for a missing or odd host", () => {
    expect(originFrom(h({}), "https://fallback.example/")).toBe("https://fallback.example");
    expect(originFrom(h({ host: "evil.example/path\"<x" }), "https://fallback.example")).toBe("https://fallback.example");
  });
});
