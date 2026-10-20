import { describe, expect, it } from "vitest";
import { PROVIDER_INFO, PROVIDERS } from "./info";
import { normalizeCredential } from "./normalize";
import { testConnection } from "./test-connection";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "github_pat_TESTONLY_0123456789abcdefABCDEF";

describe("GitHub as a connection (stage 7, B7)", () => {
  it("is a single-account provider with a read-only fine-grained token", () => {
    expect(PROVIDERS).toContain("github");
    expect(PROVIDER_INFO.github).toMatchObject({ name: "GitHub", credentialKind: "Fine-grained token", multiAccount: false, accessNote: "Metadata, Contents and Actions read" });
    expect(PROVIDER_INFO.github.needs.join(" ")).toMatch(/Metadata, Contents, Actions/);
  });
  it("accepts only fine-grained tokens", () => {
    expect(normalizeCredential("github", ` Bearer ${TOKEN} `)).toEqual({ ok: true, value: TOKEN });
    expect(normalizeCredential("github", "ghp" + "_0123456789abcdefghijklmnopqrstuvwxyz")).toEqual({ ok: false, error: "Use a fine-grained token (it starts with github_pat_). Classic tokens can't be limited to read-only." });
  });
  it("tests the token and counts the repositories it sees", async () => {
    const answers = [json({ login: "acme" }), json([{ id: 1, name: "a", full_name: "acme/a", owner: { login: "acme" }, private: true }])];
    const fetch = (async () => answers.shift()!) as unknown as typeof globalThis.fetch;
    expect(await testConnection("github", TOKEN, { fetch })).toEqual({
      ok: true, summary: "Found 1 repository",
      details: ["Metadata read ✓", "Contents and Actions read are checked per repository on the first Sync"], scopeNote: "Metadata, Contents and Actions read",
    });
  });
  it("passes GitHub's own wording on for a rejected token", async () => {
    const fetch = (async () => json({}, 401)) as unknown as typeof globalThis.fetch;
    expect(await testConnection("github", TOKEN, { fetch })).toEqual({ ok: false, kind: "auth", error: "GitHub rejected this token (401). It may have expired or been revoked." });
  });
});
