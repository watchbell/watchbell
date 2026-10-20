import { describe, expect, it } from "vitest";
import { credentialProblem, statusAfterTest, validateAccountLabel } from "./accounts";

describe("validateAccountLabel", () => {
  it("accepts a fresh label", () => {
    expect(validateAccountLabel("supabase", " utama ", { labels: [], count: 0 })).toEqual({ ok: true, label: "utama" });
  });
  it.each([
    ["supabase", "", { labels: [], count: 0 }, "Enter a name for this account."],
    ["supabase", "utama", { labels: ["utama"], count: 1 }, "Supabase already has an account called utama."],
    ["supabase", "x".repeat(41), { labels: [], count: 0 }, "Keep the name under 40 characters."],
    ["vercel", "second", { labels: ["acme"], count: 1 }, "Vercel supports one account. Replace its credential instead."],
  ] as const)("rejects %s %j", (provider, label, existing, error) => {
    expect(validateAccountLabel(provider, label, existing)).toEqual({ ok: false, error });
  });
});

describe("credentialProblem", () => {
  it("explains an unreadable credential instead of failing", () => {
    expect(credentialProblem(null)).toBe("Can't read the stored credential. The encryption key changed. Replace the credential.");
    expect(credentialProblem("tok_abc")).toBeNull();
  });
});

describe("statusAfterTest", () => {
  it("marks the account ok after a good test", () => {
    expect(statusAfterTest({ ok: true, summary: "Found 1 project", details: [] })).toEqual({ status: "ok", lastError: null });
  });
  it("marks it broken only when the credential was rejected", () => {
    expect(statusAfterTest({ ok: false, kind: "auth", error: "Vercel rejected this credential (401)." })).toEqual({ status: "error", lastError: "Vercel rejected this credential (401)." });
  });
  it.each(["transient", "format"] as const)("leaves the status alone after a %s failure", (kind) => {
    expect(statusAfterTest({ ok: false, kind, error: "x" })).toBeNull();
  });
});
