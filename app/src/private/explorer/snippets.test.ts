import { describe, expect, it } from "vitest";
import { OPS, opById } from "@/private/openapi/operations";
import { snippetsFor } from "./snippets";

const origin = "https://watch.example.com";
const op = (id: string) => opById(id)!;
const by = (id: string, req = {}) => Object.fromEntries(snippetsFor(op(id), origin, req).map((s) => [s.label, s.code]));

describe("snippetsFor", () => {
  it("gives curl, PowerShell and JavaScript for every operation, all pointing at the origin", () => {
    for (const o of OPS) {
      const s = snippetsFor(o, origin);
      expect(s.map((x) => x.label)).toEqual(["curl", "PowerShell", "JavaScript (fetch)"]);
      for (const x of s) expect(x.code, `${o.id} ${x.label}`).toContain(`${origin}${o.path.split("{")[0]}`);
    }
  });

  it("never writes a key or token: the bearer comes from an environment variable", () => {
    const k = by("status");
    expect(k.curl).toContain('-H "Authorization: Bearer $WATCHBELL_API_KEY"');
    expect(k.PowerShell).toContain('-H "Authorization: Bearer ${env:WATCHBELL_API_KEY}"');
    expect(k["JavaScript (fetch)"]).toContain("Authorization: `Bearer ${process.env.WATCHBELL_API_KEY}`");
    for (const o of OPS) for (const x of snippetsFor(o, origin)) expect(x.code).not.toMatch(/w[bp]_[A-Za-z0-9]{8,}/);
  });

  it("PowerShell uses curl.exe (not the curl alias) and backslash-escapes the quotes of the JSON body", () => {
    const ps = by("ai-chat").PowerShell;
    expect(ps.startsWith("curl.exe -X POST ")).toBe(true);
    expect(ps).toContain(`--data-raw '{\\"model\\":\\"gemini/gemini-3.8-flash\\"`);
    expect(ps).not.toMatch(/(^|\s)curl -/);
    expect(ps).toContain(" `\n  ");
  });

  it("doubles a single quote inside the PowerShell body and escapes it for bash", () => {
    const req = { body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "it's" }] }) };
    const s = by("ai-chat", req);
    expect(s.PowerShell).toContain("it''s");
    expect(s.curl).toContain("it'\\''s");
  });

  it("puts the filled query values and path values in the URL, encoded, and leaves empty ones out", () => {
    expect(by("status", { query: [{ name: "include", value: "apps,alerts" }, { name: "x", value: "" }] }).curl).toContain("'https://watch.example.com/api/v1/status?include=apps%2Calerts'");
    expect(by("status-app", { path: { app: "my app" } }).curl).toContain("/api/v1/status/apps/my%20app'");
    expect(by("status-app").curl).toContain("/api/v1/status/apps/orbit-blog'");
  });

  it("reads a heartbeat token from HEARTBEAT_TOKEN in every language, whatever was pasted", () => {
    const s = by("ping-fail", { path: { token: "hb_" + "a".repeat(32) } });
    expect(s.curl).toContain('"https://watch.example.com/api/ping/${HEARTBEAT_TOKEN}/fail"');
    expect(s.PowerShell).toContain('"https://watch.example.com/api/ping/${env:HEARTBEAT_TOKEN}/fail"');
    expect(s["JavaScript (fetch)"]).toContain("`https://watch.example.com/api/ping/${process.env.HEARTBEAT_TOKEN}/fail`");
    for (const x of Object.values(s)) {
      expect(x).not.toContain("a".repeat(32));
      expect(x).not.toContain("Authorization");
    }
  });

  it("sends the body and a JSON content type, and reads text for a text endpoint", () => {
    const js = by("ai-chat")["JavaScript (fetch)"];
    expect(js).toContain('"Content-Type": "application/json"');
    expect(js).toContain("body: JSON.stringify({");
    expect(js).toContain("console.log(res.status, await res.json());");
    expect(by("ping")["JavaScript (fetch)"]).toContain("await res.text()");
    expect(by("ai-chat").curl).toContain("-H 'Content-Type: application/json'");
  });

  it("keeps the explorer's own X-Client label out, but other headers in", () => {
    const base = { headers: [{ name: "X-Client", value: "api-explorer" }, { name: "MCP-Protocol-Version", value: "2025-06-18" }] };
    const s = by("mcp", base);
    expect(s.curl).not.toContain("api-explorer");
    expect(s.curl).toContain("-H 'MCP-Protocol-Version: 2025-06-18'");
    expect(s["JavaScript (fetch)"]).toContain('"MCP-Protocol-Version": "2025-06-18"');
    expect(by("me", { headers: [{ name: "X-Client", value: "my-agent/1.0" }] }).curl).toContain("-H 'X-Client: my-agent/1.0'");
  });

  it("shows the scheduler secrets as variables and no auth for the watchdog", () => {
    expect(by("collect").curl).toContain("Bearer $COLLECTOR_SECRET");
    expect(by("daily").curl).toContain("Bearer $CRON_SECRET");
    expect(by("watchdog").curl).not.toContain("Authorization");
    expect(by("health").curl).toBe("curl -X GET 'https://watch.example.com/api/health'");
  });

  it("falls back to the raw text for a body that isn't JSON", () => {
    const js = by("ai-chat", { body: "not json" })["JavaScript (fetch)"];
    expect(js).toContain('body: "not json",');
  });
});
