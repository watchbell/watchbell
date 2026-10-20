import { describe, expect, it, vi } from "vitest";
import { decide, LIMITS, minutesText, peekDecision, retryAfterSeconds, subjectKey, windowStart } from "./rate-limit";

describe("rate limit", () => {
  const now = new Date("2026-10-12T10:07:30Z");

  it("aligns fixed windows to the epoch", () => {
    expect(windowStart(now, 900).toISOString()).toBe("2026-10-12T10:00:00.000Z");
    expect(retryAfterSeconds(now, 900)).toBe(450);
  });

  it("hashes the subject so raw emails and IPs are never stored", () => {
    const key = subjectKey(LIMITS.signinEmail, "Owner@Example.com");
    expect(key).toMatch(/^signin-email:[0-9a-f]{32}$/);
    expect(key).not.toContain("example");
    expect(subjectKey(LIMITS.signinEmail, "owner@example.com")).toBe(key);
  });

  it("allows up to max and refuses after", async () => {
    const hit = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    expect(await decide(LIMITS.signinEmail, "a@example.com", { hit, now })).toEqual({ allowed: true, retryAfter: 450 });
    expect(await decide(LIMITS.signinEmail, "a@example.com", { hit, now })).toEqual({ allowed: false, retryAfter: 450 });
    expect(hit).toHaveBeenCalledWith(expect.stringMatching(/^signin-email:/), new Date("2026-10-12T10:00:00Z"));
  });

  it("peeks without counting: allowed only while the count is below max", () => {
    expect(peekDecision(LIMITS.signinEmail, 0, now)).toEqual({ allowed: true, retryAfter: 450 });
    expect(peekDecision(LIMITS.signinEmail, 2, now)).toEqual({ allowed: true, retryAfter: 450 });
    expect(peekDecision(LIMITS.signinEmail, 3, now)).toEqual({ allowed: false, retryAfter: 450 });
  });

  it("uses the agreed limits", () => {
    expect(LIMITS.signinIp).toEqual({ name: "signin-ip", max: 5, windowSeconds: 900 });
    expect(LIMITS.signinEmail).toEqual({ name: "signin-email", max: 3, windowSeconds: 900 });
    expect(LIMITS.credential).toEqual({ name: "credential", max: 20, windowSeconds: 600 });
    expect(LIMITS.mfaCode).toEqual({ name: "mfa-code", max: 5, windowSeconds: 300 });
    expect(LIMITS.sync).toEqual({ name: "sync", max: 10, windowSeconds: 600 });
    expect(LIMITS.refresh).toEqual({ name: "refresh", max: 10, windowSeconds: 600 });
    expect(LIMITS.check).toEqual({ name: "check", max: 30, windowSeconds: 600 });
    expect(LIMITS.monitorWrite).toEqual({ name: "monitor-write", max: 60, windowSeconds: 600 });
    expect(LIMITS.ping).toEqual({ name: "ping", max: 60, windowSeconds: 600 });
    expect(LIMITS.alertWrite).toEqual({ name: "alert-write", max: 60, windowSeconds: 600 });
  });

  it("phrases the wait in whole minutes", () => {
    expect(minutesText(30)).toBe("1 minute");
    expect(minutesText(450)).toBe("8 minutes");
  });
});

describe("stage 6 provider action limits", () => {
  it("allows 10 provider actions per member per 10 minutes and 1 per target per minute", () => {
    expect(LIMITS.providerAction).toEqual({ name: "provider-action", max: 10, windowSeconds: 600 });
    expect(LIMITS.actionTarget).toEqual({ name: "action-target", max: 1, windowSeconds: 60 });
  });
});
