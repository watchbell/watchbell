import { describe, expect, it } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";
import { AI_ALLOWED_MODELS_DEFAULT } from "@/private/ai/types";
import { allowedModel, isMcpModelAllowed, MCP_ALLOWED_MODELS, normalizeModel, scrubDeep, scrubText, stripProvider } from "./scrub";

const book = buildAliasBook([
  { id: "d1", kind: "supabase_project", name: "ticketer-prod-db", firstSeenAt: "2026-01-01T00:00:00Z" },
  { id: "a1", kind: "app", name: "ticketer", firstSeenAt: "2026-01-01T00:00:00Z" },
  { id: "h1", kind: "domain", name: "shop.example.com", firstSeenAt: "2026-01-02T00:00:00Z", parentId: "a1" },
]);

const LEAKS = ["@", "://", "postgres", "wb_", "wp_", "hb_", "sk-", "gsk_", "AIza"];

describe("scrubText (R5)", () => {
  it("removes every leak-list string", () => {
    const dirty = [
      "owner owner@example.com saw postgres://u:pw@db.host:5432/ticketer-prod-db",
      "GET https://shop.example.com/api/checkout?token=abc failed", "key wp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", "key wb_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
      "ping /api/ping/hb_0123456789abcdef0123456789abcdef", "openai sk-proj-abcdefghijk groq gsk_abcdefghijklmnop",
      "gemini AIzaSyA1234567890abcdefghij and AQ.Fake0Tstabcdefghijklmnop", "from 10.0.0.12 and user@localhost", "database ticketer-prod-db paused",
    ].join(" | ");
    const out = scrubText(dirty, book);
    for (const s of LEAKS) expect(out).not.toContain(s);
    expect(out).not.toContain("10.0.0.12");
    expect(out).not.toContain("ticketer-prod-db");
    expect(out).not.toContain("example.com");
    expect(out).toContain("db-a");
    expect(out).toContain("GET [link] failed");
  });

  it("keeps app names and monitor paths", () => {
    expect(scrubText("ticketer is down: /health answered 503", book)).toBe("ticketer is down: /health answered 503");
  });

  it("scrubDeep walks objects and arrays, turns dates into ISO strings and drops undefined", () => {
    const out = scrubDeep({ a: ["x@y.co"], b: { c: new Date("2026-10-13T00:00:00Z"), d: undefined, n: 3, z: null } }, book);
    expect(out).toEqual({ a: ["[email hidden]"], b: { c: "2026-10-13T00:00:00.000Z", n: 3, z: null } });
  });
});

describe("model allowlist (write tools)", () => {
  it("allows gemini*, antigravity*, @cf/google/gemma* and claude* (owner 08:45)", () => {
    expect(MCP_ALLOWED_MODELS).toEqual(["gemini", "antigravity", "@cf/google/gemma", "claude"]);
    expect(MCP_ALLOWED_MODELS).toBe(AI_ALLOWED_MODELS_DEFAULT); // one shared constant (stage 5c integration)
    for (const m of ["gemini-3.8-flash", "Gemini-2.5-Pro", "antigravity-preview-latest", "@cf/google/gemma-3-12b-it", "claude-sonnet-4-6", "Claude Opus 4.6 (Thinking)", "Gemini 3.8 Flash"]) {
      expect(isMcpModelAllowed(m), m).toBe(true);
    }
  });

  it("strips a provider/ prefix first", () => {
    expect(stripProvider("google/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(stripProvider("@cf/google/gemma-3")).toBe("@cf/google/gemma-3");
    for (const m of ["google/gemini-3.8-flash", "models/gemini-2.5-flash", "cloudflare/@cf/google/gemma-3-12b-it", "anthropic/claude-sonnet-4-6"]) expect(isMcpModelAllowed(m), m).toBe(true);
  });

  it("rejects other vendors, empty, junk and over-long names", () => {
    for (const m of ["gpt-4o", "openai/gpt-4o", "@cf/meta/llama-3.1-8b", "llama-3.3-70b", "", "   ", "gemini<script>", `gemini-${"x".repeat(120)}`, null, 42, "mistral/gemini"]) {
      expect(isMcpModelAllowed(m), String(m)).toBe(m === "mistral/gemini");
    }
  });

  it("normalises display names to lowercase-hyphenated", () => {
    expect(normalizeModel("Claude Opus 4.6 (Thinking)")).toBe("claude-opus-4.6-thinking");
    expect(normalizeModel("  Gemini 3.8 Flash ")).toBe("gemini-3.8-flash");
    expect(allowedModel("Claude Sonnet 4.6 (Thinking)")).toBe("claude-sonnet-4.6-thinking");
  });

  it("honours an owner-edited list", () => {
    expect(isMcpModelAllowed("claude-sonnet-4-6", ["gemini"])).toBe(false);
    expect(isMcpModelAllowed("gemini-3.8-flash", ["gemini"])).toBe(true);
  });
});
