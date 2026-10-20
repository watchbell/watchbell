import { describe, expect, it } from "vitest";
import { notifyEnv } from "./env";

describe("notifyEnv", () => {
  it("is all null when nothing is set", () => {
    expect(notifyEnv({})).toEqual({ telegramToken: null, resendKey: null, digestFrom: null });
  });
  it("reads the three optional variables", () => {
    expect(notifyEnv({ TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ", RESEND_API_KEY: "re_x", DIGEST_FROM: "Ops <a@b.co>" }))
      .toEqual({ telegramToken: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ", resendKey: "re_x", digestFrom: "Ops <a@b.co>" });
  });
  it("rejects values that can't be right", () => {
    expect(notifyEnv({ TELEGRAM_BOT_TOKEN: "not-a-token", RESEND_API_KEY: "sk_x", DIGEST_FROM: "Watchpost" }))
      .toEqual({ telegramToken: null, resendKey: null, digestFrom: null });
  });
  it("trims whitespace pasted around a value", () => {
    expect(notifyEnv({ DIGEST_FROM: "  noreply@example.com \n" }).digestFrom).toBe("noreply@example.com");
  });
});
