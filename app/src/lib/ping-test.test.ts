import { describe, expect, it } from "vitest";
import { pingTestPath, pingTestResult } from "./ping-test";

const T = "hb_0123456789abcdef0123456789abcdef";

describe("pingTestResult", () => {
  it("words each answer the ping route can give", () => {
    expect(pingTestResult(200)).toEqual({ ok: true, text: "OK · 200" });
    expect(pingTestResult(404)).toEqual({ ok: false, text: "Not found · 404" });
    expect(pingTestResult(429)).toEqual({ ok: false, text: "Too many pings · 429" });
    expect(pingTestResult(503)).toEqual({ ok: false, text: "Failed · 503" });
    expect(pingTestResult(null)).toEqual({ ok: false, text: "Couldn't reach the console" });
  });
});

describe("pingTestPath", () => {
  it("keeps only the path, with /fail for a failure ping", () => {
    expect(pingTestPath(`https://ops.example.com/api/ping/${T}`, "ok")).toBe(`/api/ping/${T}`);
    expect(pingTestPath(`https://ops.example.com/api/ping/${T}`, "fail")).toBe(`/api/ping/${T}/fail`);
  });
  it("refuses anything that isn't a ping URL", () => {
    expect(pingTestPath("https://ops.example.com/other", "ok")).toBeNull();
  });
});
