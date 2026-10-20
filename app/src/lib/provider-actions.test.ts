import { describe, expect, it } from "vitest";
import { cooldownText, scopeMessage, shortDetail, STALE } from "@/lib/provider-actions";

describe("scopeMessage", () => {
  it("tells a Supabase owner the token is read-only", () => {
    expect(scopeMessage("supabase", {})).toBe("This token is read-only; replace it with one that has Project admin write.");
  });

  it("names the Vercel team", () => {
    expect(scopeMessage("vercel", { team: "acme" })).toBe("This token can't change projects in team acme; replace it with one whose scope includes that team.");
  });

  it("names the Neon project", () => {
    expect(scopeMessage("neon", { project: "quillpad" })).toBe(
      "This API key can't manage project quillpad; replace it with a personal or organization key, or a key for this project.",
    );
  });

  it("tells a Cloudflare owner which permission to add (slice 2)", () => {
    expect(scopeMessage("cloudflare", {})).toBe("This Cloudflare token can't edit DNS; add \"Zone → DNS → Edit\" to it, or replace it with a token that has it.");
  });

  it("falls back to a neutral word when the name is unknown", () => {
    expect(scopeMessage("vercel", {})).toContain("in team this team;");
    expect(scopeMessage("neon", {})).toContain("project this project;");
  });
});

describe("messages", () => {
  it("has the stale-dialog sentence", () => {
    expect(STALE).toBe("This changed since you opened it. Reload and try again.");
  });

  it("explains the per-member quota and the per-target cooldown", () => {
    expect(cooldownText("member", 120)).toBe("Too many actions. Try again in 2 minutes.");
    expect(cooldownText("target", 30)).toBe("That was just done. Wait a minute before trying again.");
  });
});

describe("shortDetail", () => {
  it("keeps one line of at most 200 characters", () => {
    expect(shortDetail("a\n  b")).toBe("a b");
    const long = shortDetail("x".repeat(300));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
