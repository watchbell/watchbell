import { describe, expect, it } from "vitest";
import { clip, pathOnly, scrubLog } from "./scrub";

describe("scrubLog", () => {
  it.each([
    ["Authorization: Bearer abc.def-123", "Authorization: Bearer [hidden]"],
    ["token=eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxIn0.sig_part-1 ok", "token=[hidden] ok"],
    ["jwt eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxIn0.c2lnbmF0dXJl here", "jwt [jwt] here"],
    ['{"password":"hunter2","user":"x"}', '{"password":"[hidden]","user":"x"}'],
    ["api_key: sk_live_abcdef", "api_key: [hidden]"],
    ["connect postgresql://u:p@db.example.com:5432/x failed", "connect postgresql://[hidden] failed"],
    ["fetch https://user:pw@example.com/a", "fetch https://[hidden]@example.com/a"],
    ["mail to someone@example.com bounced", "mail to [email] bounced"],
    ["key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 used", "key [redacted] used"],
  ])("%s", (input, out) => expect(scrubLog(input)).toBe(out));
  it("leaves ordinary text and long URL paths alone", () => {
    expect(scrubLog("GET /courses 500 Supabase: project is paused")).toBe("GET /courses 500 Supabase: project is paused");
    const path = "/dashboard/settings/notifications/telegram/connect/step-two";
    expect(scrubLog(path)).toBe(path);
  });
  it("hides a heartbeat ping token in a message or a path (B2)", () => {
    expect(scrubLog("GET /api/ping/hb_0123456789abcdef0123456789abcdef/fail → 503")).toBe("GET /api/ping/hb_[hidden]/fail → 503");
    expect(pathOnly(scrubLog("/api/ping/hb_0123456789abcdef0123456789abcdef?x=1"))).toBe("/api/ping/hb_[hidden]");
    expect(scrubLog("HEAD /api/ping/HB_0123456789ABCDEF0123456789ABCDEF")).toBe("HEAD /api/ping/hb_[hidden]");
  });
  it("hides a percent-encoded ping token too, in any case (5b final review M4)", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(scrubLog(`GET /api/ping/hb%5F${hex}/start`)).toBe("GET /api/ping/hb_[hidden]/start");
    expect(scrubLog(`GET /api/ping/HB%5f${hex.toUpperCase()}`)).toBe("GET /api/ping/hb_[hidden]");
    expect(scrubLog(`token hb%5F${hex} in a message`)).toBe("token hb_[hidden] in a message");
    // Encoded letters or an encoded slash before the token: whatever follows the ping prefix is hidden.
    expect(scrubLog(`GET /api/ping/%68%62_${hex}/fail → 200`)).toBe("GET /api/ping/[hidden]/fail → 200");
    expect(pathOnly(scrubLog(`/api/ping/x%2Fhb_${hex}?a=1`))).toBe("/api/ping/[hidden]");
    expect(scrubLog(`/api%2Fping%2F%68b_${hex}`)).toBe("/api%2Fping%2F[hidden]");
    expect(scrubLog(`/api/ping%2Fhb_${hex}`)).toBe("/api/ping%2Fhb_[hidden]");
    // The bare prefix and other routes are left alone.
    expect(scrubLog("GET /api/ping/ 404")).toBe("GET /api/ping/ 404");
    expect(scrubLog("GET /api/pingdom/status")).toBe("GET /api/pingdom/status");
  });
  it("masks Basic credentials too", () => {
    expect(scrubLog("authorization: Basic dXNlcjpwYXNz")).toBe("authorization: Basic [hidden]");
  });
});

describe("clip and pathOnly", () => {
  it("cuts long text with an ellipsis", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
  it("drops query strings and fragments", () => {
    expect(pathOnly("/api/x?token=1#y")).toBe("/api/x");
    expect(pathOnly(null)).toBeNull();
  });
});
