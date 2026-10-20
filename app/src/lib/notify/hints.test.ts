import { describe, expect, it } from "vitest";
import { maskHint } from "./hints";

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
  it("shows two letters of the digest address", () => {
    expect(maskHint("email_digest", { to: "alex@example.com" })).toBe("al…@…");
  });
});
