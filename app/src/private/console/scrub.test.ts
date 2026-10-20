import { describe, expect, it } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";
import { LEAK_PATTERNS, scrubText } from "./scrub";

const book = buildAliasBook(
  [
    { id: "app1", kind: "app", name: "orbit-blog", firstSeenAt: "2026-01-01T00:00:00Z" },
    { id: "db1", kind: "supabase_project", name: "atlas-main", firstSeenAt: "2026-01-02T00:00:00Z" },
  ],
  [{ id: "acc1", label: "acme-personal", createdAt: "2026-01-01T00:00:00Z" }],
);

const leaks = (s: string) => LEAK_PATTERNS.filter((p) => s.includes(p));

describe("scrubText (R5)", () => {
  it("replaces database names with their alias and keeps app names", () => {
    expect(scrubText("orbit-blog: database atlas-main is paused", book)).toBe("orbit-blog: database db-a is paused");
  });
  it("replaces account labels with their alias", () => {
    expect(scrubText("Account acme-personal has no free slot", book)).toBe("Account account-1 has no free slot");
  });
  it("hides emails and any remaining @", () => {
    const out = scrubText("owner someone@example.com asked, import @vercel/og failed", book);
    expect(out).not.toContain("@");
    expect(out).toContain("[email");
  });
  it("reduces URLs to their path and never leaves ://", () => {
    expect(scrubText("GET https://web.example.com/api/health?token=abc failed", book)).toBe("GET /api/health failed");
    expect(scrubText("could not reach https://web.example.com", book)).toBe("could not reach [url]");
    expect(scrubText("postgres://user:pw@db.example.com:5432/app", book)).not.toContain("://");
  });
  it("hides API keys, heartbeat tokens and provider keys", () => {
    const text = [
      "key wp_" + "A".repeat(40), "new key wb_" + "B".repeat(40), "ping /api/ping/hb_" + "0123456789abcdef".repeat(2), "sk-" + "x".repeat(30), "gsk_" + "y".repeat(30),
      "AIza" + "z".repeat(35), "AQ." + "w".repeat(40),
    ].join(" ; ");
    const out = scrubText(text, book);
    expect(leaks(out)).toEqual([]);
  });
  it("passes plain text through", () => {
    expect(scrubText("HTTP 502 for 4 min", book)).toBe("HTTP 502 for 4 min");
  });
});
