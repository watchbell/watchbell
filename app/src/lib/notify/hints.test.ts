import { describe, expect, it } from "vitest";
import { maskHint, recipients } from "./hints";

describe("maskHint", () => {
  it("shows the Telegram chat's name and the end of its id", () => {
    expect(maskHint("telegram", { chatId: "123456789", chatLabel: "Alex (private)" })).toBe("Alex (private) · …6789");
  });
  it("shows only the end of the Discord webhook id, never the token", () => {
    const url = "https://discord.com/api/web" + "hooks/123456789012345678/SECRETTOKENabcdefghijklmnop";
    const hint = maskHint("discord", { url });
    expect(hint).toBe("webhook …5678");
    expect(hint).not.toContain("SECRET");
  });
  it("1.2.4: SMTP shows two letters of the first address and how many more", () => {
    const c = { host: "smtp.example.com", port: 465 as const, user: "u", pass: "secret", from: "a@example.com", to: "alex@example.com" };
    expect(maskHint("smtp", c)).toBe("smtp.example.com:465 · to al…@…");
    expect(maskHint("smtp", { ...c, to: "alex@example.com, sam@example.com, kim@example.com" })).toBe("smtp.example.com:465 · to al…@… +2");
    expect(recipients(" a@x.io ;A@x.io, b@x.io\nc@x.io ")).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
  });
  it("shows two letters of the digest address", () => {
    expect(maskHint("email_digest", { to: "alex@example.com" })).toBe("al…@…");
  });
});
