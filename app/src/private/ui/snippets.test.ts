import { describe, expect, it } from "vitest";
import { agentPrompt, automationPrompt, KEY_PLACEHOLDER, LOCAL_ORIGIN, mcpConfigs, MCP_TOOLS, originChoices, pickOrigin, questionsPrompt, quickStart } from "./snippets";

const O = "https://watch.example.test";
// A tab by its label: an edition may put its own agent's tabs first (SNIPPETS_COPY; the private edition's are pinned in
// snippets.extras.test.ts).
const tab = (tabs: [string, string][], label: string): string => tabs.find(([l]) => l === label)?.[1] ?? "";
const all = (origin: string) => [
  ...quickStart(origin).map(([l, c]) => [`quickStart ${l}`, c] as const),
  ...mcpConfigs(origin).map(([l, c]) => [`mcp ${l}`, c] as const),
  ["agentPrompt", agentPrompt(origin)] as const,
  ["automationPrompt", automationPrompt(origin)] as const,
  ["questionsPrompt", questionsPrompt(origin)] as const,
];

describe("snippets", () => {
  it("uses the origin it is given and nothing hard-coded", () => {
    const other = "http://127.0.0.1:4999";
    for (const [name, code] of all(O)) {
      expect(code, name).not.toContain("ops.example.com");
      expect(code, name).not.toContain("localhost:3100");
    }
    for (const [name, code] of [...quickStart(O), ...mcpConfigs(O)].map(([l, c]) => [l, c] as const)) {
      // The "Other clients" tab and the prompts name the URL too; every code tab mentions the origin at least once, except pure env tabs.
      expect(code.includes(O) || /^Env/.test(name), name).toBe(true);
    }
    expect(mcpConfigs(other).every(([, c]) => c.includes(other) && !c.includes(O))).toBe(true);
  });

  it("never contains something that looks like a real key", () => {
    for (const [name, code] of all(O)) expect(code, name).not.toMatch(/w[bp]_[A-Za-z0-9]{40}/);
    expect(KEY_PLACEHOLDER).toBe("wb_YOUR_KEY");
  });

  it("points every MCP snippet at /api/v1/mcp", () => {
    for (const [name, code] of mcpConfigs(O)) expect(code, name).toContain(`${O}/api/v1/mcp`);
    expect(agentPrompt(O)).toContain(`${O}/api/v1/mcp`);
  });

  it("ends with the shared tabs: Gemini CLI, OpenClaw, other clients and a curl test", () => {
    expect(mcpConfigs(O).map(([l]) => l).slice(-4)).toEqual(["Gemini CLI", "OpenClaw", "Other clients", "Test with curl"]);
  });

  it("Gemini CLI: add command with --transport http and a settings.json with httpUrl", () => {
    const code = tab(mcpConfigs(O), "Gemini CLI");
    expect(code).toContain(`gemini mcp add --transport http watchbell ${O}/api/v1/mcp`);
    expect(code).toContain('--header "Authorization: Bearer $WATCHBELL_API_KEY"');
    const json = JSON.parse(code.slice(code.lastIndexOf("{\n  \"mcpServers\"")));
    expect(json.mcpServers.watchbell.httpUrl).toBe(`${O}/api/v1/mcp`);
    expect(json.mcpServers.watchbell.headers.Authorization).toBe("Bearer $WATCHBELL_API_KEY");
  });

  it("OpenClaw: mcp set with streamable-http and a probe", () => {
    const code = tab(mcpConfigs(O), "OpenClaw");
    expect(code).toContain("openclaw mcp set watchbell '");
    const body = code.slice(code.indexOf("'{") + 1, code.indexOf("}'") + 1);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ url: `${O}/api/v1/mcp`, transport: "streamable-http", headers: { Authorization: "Bearer wb_YOUR_KEY" } });
    expect(code).toContain("openclaw mcp probe watchbell");
  });

  it("generic tab has the URL, header and the mcp-remote fallback", () => {
    const code = tab(mcpConfigs(O), "Other clients");
    expect(code).toContain("npx mcp-remote");
    expect(code).toContain("Authorization: Bearer wb_YOUR_KEY");
  });

  it("keeps shell variables literal (no template substitution leaked into the text)", () => {
    for (const [name, code] of all(O)) {
      expect(code, name).not.toMatch(/undefined|\[object/);
    }
    expect(quickStart(O)[0][1]).toContain('-H "Authorization: Bearer $WATCHBELL_API_KEY"');
    expect(quickStart(O)[0][1]).toContain(`${O}/api/v1/ai/chat/completions`);
    expect(quickStart(O)[1][1]).toContain("process.env.WATCHBELL_API_KEY");
  });

  it("quick start has the four tabs the mockup shows, on Gemini models only", () => {
    expect(quickStart(O).map(([l]) => l)).toEqual(["cURL", "Chat Completions (OpenAI SDK)", "AI SDK", "Coding agents"]);
    for (const [, code] of quickStart(O)) expect(code).not.toMatch(/claude|anthropic|gpt|llama|groq/i);
  });

  it("the daily automation: list_apps, get_app for non-running apps, submit_ai_note with a Gemini model", () => {
    const p = automationPrompt(O);
    expect(p).toMatch(/08:00/);
    expect(p.indexOf("list_apps")).toBeLessThan(p.indexOf("get_app"));
    expect(p.indexOf("get_app")).toBeLessThan(p.indexOf("submit_ai_note"));
    expect(p).toContain("gemini-3.8-flash");
    expect(p).toMatch(/running/);
    expect(p).toMatch(/stop without writing/i);
  });

  it("the questions automation: list_pending_questions then answer_question", () => {
    const p = questionsPrompt(O);
    expect(p.indexOf("list_pending_questions")).toBeLessThan(p.indexOf("answer_question"));
    expect(p).toContain("gemini-3.8-flash");
  });

  it("lists the MCP tools incl. submit_ai_note and the inbox pair", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_apps", "get_app", "submit_ai_note", "list_pending_questions", "answer_question"]));
    expect(MCP_TOOLS.filter((t) => t.write).map((t) => t.name).sort()).toEqual(["answer_question", "submit_ai_note"]);
  });
});

describe("origin choices", () => {
  it("offers local and production; the current origin is preselected", () => {
    const c = originChoices("https://ops.example.com/");
    expect(c.map((x) => x.id)).toEqual(["production", "local"]);
    expect(c[0].origin).toBe("https://ops.example.com");
    expect(c[1].origin).toBe(LOCAL_ORIGIN);
    expect(pickOrigin(c, "https://ops.example.com").id).toBe("production");
    expect(pickOrigin(originChoices("http://localhost:3100"), "http://localhost:3100").id).toBe("local");
  });

  it("when the console itself runs on localhost, production falls back to the known domain", () => {
    const c = originChoices("http://localhost:3100");
    expect(c.find((x) => x.id === "production")?.origin).toBe("https://ops.example.com");
  });
});

import { headlessPrompt, serverSetup } from "./snippets";
describe("server setup (headless VM)", () => {
  const tabs = serverSetup(O);
  it("has OpenClaw, Gemini CLI and the two cron tabs, all on the given origin", () => {
    expect(tabs.map(([l]) => l).slice(-4)).toEqual(["OpenClaw", "Gemini CLI", "Cron: automations", "Cron: heartbeat"]);
    for (const [name, code] of tabs.slice(0, -2)) expect(code, name).toContain(`${O}/api/v1/mcp`);
    expect(tab(tabs, "Cron: heartbeat")).toContain(`${O}/api/ping/<token>`);
    for (const [name, code] of tabs) {
      expect(code, name).not.toMatch(/w[bp]_[A-Za-z0-9]{40}/);
      expect(code, name).not.toContain("ops.example.com");
      expect(code, name).not.toMatch(/9router/i);
      expect(code, name).not.toMatch(/undefined|\[object/);
    }
  });
  it("OpenClaw keeps the key out of the command: ${VAR} in the header, the value in ~/.openclaw/.env", () => {
    const code = tab(tabs, "OpenClaw");
    expect(code).toContain("~/.openclaw/.env");
    expect(code).toContain('"Authorization": "Bearer ${WATCHBELL_API_KEY}"');
    expect(code).toContain("openclaw mcp set watchbell '");
  });
  it("Gemini CLI: httpUrl + headers + trust, and a headless -p run", () => {
    const code = tab(tabs, "Gemini CLI");
    const json = JSON.parse(code.slice(code.indexOf("{\n  \"mcpServers\""), code.indexOf("}\n}\n") + 3));
    expect(json.mcpServers.watchbell).toEqual({ httpUrl: `${O}/api/v1/mcp`, headers: { Authorization: "Bearer $WATCHBELL_API_KEY" }, trust: true });
    expect(code).toContain("gemini -m gemini-3.8-flash -p");
  });
  it("the cron job runs gemini every 6 hours with the daily prompt from a file (no Schedule line)", () => {
    const code = tab(tabs, "Cron: automations");
    expect(code).toContain("0 */6 * * *");
    expect(code).toContain('-p "$(cat $HOME/watchbell-daily.txt)"');
    expect(code).toContain("list_apps");
    expect(code).not.toContain("Schedule:");
    expect(headlessPrompt(O)).toContain("submit_ai_note");
    expect(code).not.toMatch(/%/);
  });
  it("the heartbeat line is every 5 minutes with curl -fsS -m 10", () => {
    expect(tab(tabs, "Cron: heartbeat")).toContain("*/5 * * * * curl -fsS -m 10");
  });
});
