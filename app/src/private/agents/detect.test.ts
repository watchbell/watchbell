import { describe, expect, it } from "vitest";
import { agentStatus, detectClient, sanitizeName, sanitizeVersion } from "./detect";

const h = (o: Record<string, string>) => new Headers(o);

describe("detectClient (R6: MCP clientInfo > X-Client > User-Agent > unknown)", () => {
  it("MCP clientInfo wins over X-Client and the User-Agent", () => {
    const c = detectClient(h({ "x-client": "other/9", "user-agent": "curl/8.9.1" }), { name: "Antigravity", version: "1.12" });
    expect(c).toMatchObject({ name: "antigravity", version: "1.12", via: "mcp", userAgent: "curl/8.9.1" });
  });
  it("reads X-Client name/version", () => {
    expect(detectClient(h({ "x-client": "OpenClaw/2026.10.2" }))).toMatchObject({ name: "openclaw", version: "2026.10.2", via: "x-client" });
  });
  it("takes the first product token of the User-Agent", () => {
    const c = detectClient(h({ "user-agent": "GeminiCLI/0.9.0 (win32; x64)" }));
    expect(c).toMatchObject({ name: "geminicli", version: "0.9.0", via: "user-agent", userAgent: "GeminiCLI/0.9.0 (win32; x64)" });
  });
  it("is unknown without any hint", () => {
    expect(detectClient(h({}))).toEqual({ name: "unknown", version: "", via: "unknown", userAgent: "" });
  });
  it("falls through a source whose name sanitizes to nothing", () => {
    expect(detectClient(h({ "x-client": "***/1", "user-agent": "node-fetch/3.3" }), { name: "\u{1F916}" })).toMatchObject({ name: "node-fetch", via: "user-agent" });
  });
  it("ignores a non-string MCP name or version", () => {
    expect(detectClient(h({ "user-agent": "curl/8.9.1" }), { name: 42, version: {} })).toMatchObject({ name: "curl", via: "user-agent" });
    expect(detectClient(h({}), { name: "goose", version: 7 })).toMatchObject({ name: "goose", version: "", via: "mcp" });
  });
  it("cuts the stored User-Agent to 200 characters", () => {
    expect(detectClient(h({ "user-agent": `curl/8 ${"x".repeat(500)}` })).userAgent).toHaveLength(200);
  });
  it("a name without a version still counts (UA token, bare X-Client)", () => {
    expect(detectClient(h({ "x-client": "portfolio" }))).toMatchObject({ name: "portfolio", version: "", via: "x-client" });
    expect(detectClient(h({ "user-agent": "Mozilla" }))).toMatchObject({ name: "mozilla", version: "", via: "user-agent" });
  });
  it("strips control characters from the stored User-Agent", () => {
    expect(detectClient(h({ "user-agent": "curl/8\u0001.9 (a\tb)" })).userAgent).toBe("curl/8.9 (a b)");
  });
});

describe("sanitizeName", () => {
  it("lower-cases and keeps [a-z0-9._-]", () => {
    expect(sanitizeName("Gemini-CLI_v2.1")).toBe("gemini-cli_v2.1");
  });
  it("replaces anything else, emoji included, and trims the edges", () => {
    expect(sanitizeName("\u{1F916} my agent!!")).toBe("my-agent");
    expect(sanitizeName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeName("<script>alert(1)</script>")).toBe("script-alert-1-script");
  });
  it("cuts at 40 characters and returns an empty string when nothing is left", () => {
    expect(sanitizeName("a".repeat(200))).toHaveLength(40);
    expect(sanitizeName("\u{1F916}\u{1F916}")).toBe("");
    expect(sanitizeName("")).toBe("");
    expect(sanitizeName(undefined)).toBe("");
  });
});

describe("sanitizeVersion", () => {
  it("keeps [A-Za-z0-9._+-] up to 24 characters", () => {
    expect(sanitizeVersion("0.9.0+build 5")).toBe("0.9.0+build5");
    expect(sanitizeVersion("1".repeat(60))).toHaveLength(24);
    expect(sanitizeVersion(5)).toBe("");
  });
});

describe("agentStatus", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  it("is active within 30 minutes, idle after, revoked when the key is", () => {
    expect(agentStatus(new Date("2026-10-13T11:30:00Z"), false, now)).toBe("active");
    expect(agentStatus(new Date("2026-10-13T11:29:59Z"), false, now)).toBe("idle");
    expect(agentStatus(new Date("2026-10-13T11:59:00Z"), true, now)).toBe("revoked");
  });
});
