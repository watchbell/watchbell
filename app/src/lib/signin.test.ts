import { describe, expect, it, vi } from "vitest";
import { memoryLimiter } from "./memory-limit";
import { requestSignIn } from "./signin";

const siteUrl = "https://console.example.com";
const allow = vi.fn(async () => ({ allowed: true, retryAfter: 900 }));
const base = { siteUrl, captchaToken: "tok", ip: "1.2.3.4", limit: allow, peek: allow };
const ok = async () => ({ error: null });
const unavailable = { status: "error", message: "We couldn't send the email right now. Try again in a minute." };

describe("requestSignIn", () => {
  // Watchbell 1.2.1 (audit M2): the in-memory per-IP count runs before the first database write.
  it("refuses past the in-memory per-IP limit without touching the database or Supabase", async () => {
    const memory = memoryLimiter({ max: 2, windowMs: 900_000 });
    const limit = vi.fn(async () => ({ allowed: true, retryAfter: 900 }));
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    for (let i = 0; i < 2; i++) expect((await requestSignIn("a@example.com", { ...base, limit, peek: limit, memory, signInWithOtp })).status).toBe("sent");
    const calls = limit.mock.calls.length;
    const r = await requestSignIn("a@example.com", { ...base, limit, peek: limit, memory, signInWithOtp });
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("Too many sign-in attempts") });
    expect(limit.mock.calls.length).toBe(calls);
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
    expect((await requestSignIn("a@example.com", { ...base, ip: "5.6.7.8", limit, peek: limit, memory, signInWithOtp })).status).toBe("sent");
  });

  it("rejects an invalid email before anything else", async () => {
    const signInWithOtp = vi.fn();
    expect(await requestSignIn("not-an-email", { ...base, signInWithOtp })).toEqual({ status: "error", message: "Enter a valid email address.", field: true });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("asks for the bot check when the captcha token is missing", async () => {
    const signInWithOtp = vi.fn();
    expect(await requestSignIn("a@example.com", { ...base, captchaToken: "", signInWithOtp })).toEqual({ status: "error", message: "Complete the bot check below first." });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("passes the captcha token, never creates users, normalises the email", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    await requestSignIn("  Me@Example.com ", { ...base, signInWithOtp });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "me@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: `${siteUrl}/auth/confirm`, captchaToken: "tok" },
    });
  });

  it("refuses over the IP limit before calling Supabase", async () => {
    const signInWithOtp = vi.fn();
    const deny = vi.fn(async () => ({ allowed: false, retryAfter: 420 }));
    const r = await requestSignIn("a@example.com", { ...base, limit: deny, signInWithOtp });
    expect(r).toEqual({ status: "error", message: "Too many sign-in attempts. Try again in 7 minutes." });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("refuses when the email is already at its limit, without calling Supabase or counting", async () => {
    const signInWithOtp = vi.fn();
    const limit = vi.fn(async () => ({ allowed: true, retryAfter: 900 }));
    const peek = vi.fn(async () => ({ allowed: false, retryAfter: 420 }));
    const r = await requestSignIn("a@example.com", { ...base, limit, peek, signInWithOtp });
    expect(r).toEqual({ status: "error", message: "Too many sign-in attempts. Try again in 7 minutes." });
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "signin-email" }), expect.anything());
  });

  it("counts the IP first, then peeks at the email, then counts the email after Supabase", async () => {
    const calls: string[] = [];
    const limit = vi.fn(async (l: { name: string }) => { calls.push(`limit:${l.name}`); return { allowed: true, retryAfter: 900 }; });
    const peek = vi.fn(async (l: { name: string }) => { calls.push(`peek:${l.name}`); return { allowed: true, retryAfter: 900 }; });
    const signInWithOtp = vi.fn(async () => { calls.push("supabase"); return { error: null }; });
    await requestSignIn("a@example.com", { ...base, limit, peek, signInWithOtp });
    expect(calls).toEqual(["limit:signin-ip", "peek:signin-email", "supabase", "limit:signin-email"]);
    expect(limit).toHaveBeenCalledWith(expect.objectContaining({ name: "signin-ip" }), "1.2.3.4");
    expect(peek).toHaveBeenCalledWith(expect.objectContaining({ name: "signin-email" }), "a@example.com");
    expect(limit).toHaveBeenCalledWith(expect.objectContaining({ name: "signin-email" }), "a@example.com");
  });

  it("counts an invited and an uninvited email exactly once each", async () => {
    for (const result of [{ error: null }, { error: { status: 422, code: "otp_disabled" } }]) {
      const limit = vi.fn(async (l: { name: string }) => { void l; return { allowed: true, retryAfter: 900 }; });
      await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: async () => result });
      const emailCounts = limit.mock.calls.filter(([l]) => l.name === "signin-email");
      expect(emailCounts).toHaveLength(1);
    }
  });

  it("answers an uninvited email exactly like an invited one", async () => {
    const invited = await requestSignIn("a@example.com", { ...base, signInWithOtp: ok });
    const stranger = await requestSignIn("a@example.com", { ...base, signInWithOtp: async () => ({ error: { status: 422, code: "otp_disabled" } }) });
    expect(stranger).toEqual(invited);
    expect(invited).toEqual({ status: "sent", email: "a@example.com" });
  });

  it("says the bot check failed, and does not count the email against its owner", async () => {
    const limit = vi.fn(async () => ({ allowed: true, retryAfter: 900 }));
    const r = await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: async () => ({ error: { status: 400, code: "captcha_failed" } }) });
    expect(r).toEqual({ status: "error", message: "The bot check didn't pass. Try again." });
    expect(limit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "signin-email" }), expect.anything());
  });

  it("says so when Supabase itself is failing, without counting the email", async () => {
    const limit = vi.fn(async () => ({ allowed: true, retryAfter: 900 }));
    expect(await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: async () => ({ error: { status: 503 } }) })).toEqual(unavailable);
    expect(await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: async () => ({ error: { status: 0, name: "AuthRetryableFetchError" } }) })).toEqual(unavailable);
    expect(await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: async () => { throw new Error("offline"); } })).toEqual(unavailable);
    expect(limit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "signin-email" }), expect.anything());
  });

  it("says so when the limiter's database fails, instead of throwing", async () => {
    const signInWithOtp = vi.fn();
    const boom = vi.fn(async () => { throw new Error("db down"); });
    expect(await requestSignIn("a@example.com", { ...base, limit: boom, signInWithOtp })).toEqual(unavailable);
    expect(await requestSignIn("a@example.com", { ...base, peek: boom, signInWithOtp })).toEqual(unavailable);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("says so when counting the email fails after Supabase answered", async () => {
    const limit = vi.fn(async (l: { name: string }) => {
      if (l.name === "signin-email") throw new Error("db down");
      return { allowed: true, retryAfter: 900 };
    });
    expect(await requestSignIn("a@example.com", { ...base, limit, signInWithOtp: ok })).toEqual(unavailable);
  });
});
