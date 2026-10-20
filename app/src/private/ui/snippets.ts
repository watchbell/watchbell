// Copy-paste text for the AI Gateway pages: quick start, MCP configs for each agent, the prompts. Pure functions of the
// origin (the console's own base URL), so a local test and production show their own URLs. No real key ever appears:
// KEY_PLACEHOLDER (or the env var $WATCHBELL_API_KEY) stands in. Gemini models only (owner ruling, 13 Oct).

import { SNIPPETS_COPY } from "@/lib/copy/edition";
import { timeZone } from "@/lib/time";

export const KEY_PLACEHOLDER = "wb_YOUR_KEY";
export const DEFAULT_MODEL = "gemini/gemini-3.8-flash";
// The model name an Antigravity automation reports when it writes (MCP write tools accept Gemini models only).
export const AGENT_MODEL = "gemini-3.8-flash";

// The owner's two places to test (13 Oct): the local dev server and production. The page preselects the one that
// matches the console's own SITE_URL; snippets themselves only ever use the origin they are handed.
export const LOCAL_ORIGIN = "http://localhost:3100";
export const PRODUCTION_ORIGIN = "https://ops.example.com";

export type OriginChoice = { id: "production" | "local"; label: string; origin: string };

const trimOrigin = (o: string) => o.trim().replace(/\/+$/, "");
const isLocal = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(trimOrigin(o));

// Stage 8 cleanup: the "Local test" choice exists only in development (or when the console itself runs on localhost);
// a production deployment shows its own origin alone.
export function originChoices(siteUrl: string, dev: boolean = process.env.NODE_ENV !== "production"): OriginChoice[] {
  const site = trimOrigin(siteUrl);
  const production: OriginChoice = { id: "production", label: "Production", origin: isLocal(site) ? PRODUCTION_ORIGIN : site };
  if (!dev && !isLocal(site)) return [production];
  return [production, { id: "local", label: "Local test", origin: isLocal(site) ? site : LOCAL_ORIGIN }];
}

// The choice whose origin equals `current` (the page's own), else the first.
export function pickOrigin(choices: OriginChoice[], current: string): OriginChoice {
  const c = trimOrigin(current);
  return choices.find((x) => x.origin === c) ?? choices[0];
}

export type CodeTab = [label: string, code: string];

const base = (origin: string) => trimOrigin(origin);
export const mcpUrl = (origin: string) => `${base(origin)}/api/v1/mcp`;
export const aiBaseUrl = (origin: string) => `${base(origin)}/api/v1/ai`;

export function quickStart(origin: string, model: string = DEFAULT_MODEL): CodeTab[] {
  const ai = aiBaseUrl(origin);
  const mcp = mcpUrl(origin);
  return [
    ["cURL", `curl ${ai}/chat/completions \\
  -H "Authorization: Bearer $WATCHBELL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Client: my-app/1.0" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "Why is my app slow?" }]
  }'`],
    ["Chat Completions (OpenAI SDK)", `// npm i openai
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.WATCHBELL_API_KEY,
  baseURL: "${ai}",
  defaultHeaders: { "X-Client": "my-app/1.0" },
});

const res = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Why is my app slow?" }],
});
console.log(res.choices[0].message.content);`],
    ["AI SDK", `// npm i ai @ai-sdk/openai-compatible
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const watchbell = createOpenAICompatible({
  name: "watchbell",
  baseURL: "${ai}",
  apiKey: process.env.WATCHBELL_API_KEY,
  headers: { "X-Client": "my-app/1.0" },
});

const { text } = await generateText({
  model: watchbell("${model}"),
  prompt: "Why is my app slow?",
});`],
    ["Coding agents", `# Agents that speak the OpenAI API (OpenClaw, Continue, Aider, Cline ...)
OPENAI_BASE_URL=${ai}
OPENAI_API_KEY=$WATCHBELL_API_KEY
model: ${model}

# Read-only console data over MCP (key needs read:status). Full configs: AI Gateway > Connect an agent
MCP server: ${mcp}
Header:     Authorization: Bearer $WATCHBELL_API_KEY`],
  ];
}

// The MCP configs (verified 2026-10-13, see the comments above each).
export function mcpConfigs(origin: string): CodeTab[] {
  const url = mcpUrl(origin);
  // verified 2026-10-13: https://geminicli.com/docs/tools/mcp-server/ (gemini mcp add --transport http, -H/--header, httpUrl + headers)
  const gemini = `# Gemini CLI: one command ...
gemini mcp add --transport http watchbell ${url} \\
  --header "Authorization: Bearer $WATCHBELL_API_KEY"

# ... or by hand in ~/.gemini/settings.json
{
  "mcpServers": {
    "watchbell": {
      "httpUrl": "${url}",
      "headers": { "Authorization": "Bearer $WATCHBELL_API_KEY" }
    }
  }
}`;
  // verified 2026-10-13: https://docs.openclaw.ai/cli/mcp and https://docs.openclaw.ai/cli/mcp/transports (url, transport
  // "streamable-http", headers; openclaw mcp set <name> '<json>'; "probe" is its own subcommand, there is no --probe flag).
  const claw = `# OpenClaw
openclaw mcp set watchbell '{
  "url": "${url}",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }
}'
openclaw mcp probe watchbell`;
  const other = `# Any MCP client with Streamable HTTP
URL:     ${url}
Header:  Authorization: Bearer ${KEY_PLACEHOLDER}
Scope:   read:status

# Clients that only speak stdio
npx mcp-remote ${url} --header "Authorization: Bearer $WATCHBELL_API_KEY"`;
  // A one-shot check from a terminal: the server is stateless, so a single initialize call is enough, and the call
  // shows up under Agents as "curl-test".
  const test = `# Check the connection from a terminal (shows up under Agents as curl-test)
curl -s ${url} \\
  -H "Authorization: Bearer $WATCHBELL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"1"}}}'`;
  return [...SNIPPETS_COPY.mcpTabs(url, KEY_PLACEHOLDER), ["Gemini CLI", gemini], ["OpenClaw", claw], ["Other clients", other], ["Test with curl", test]];
}

export const MCP_TOOLS: { name: string; what: string; write?: boolean }[] = [
  { name: "list_apps", what: "Every app with its state, uptime 30d and last deploy" },
  { name: "get_app", what: "One app: state, the Why problems with their remedies, monitors, linked database alias" },
  { name: "list_alerts", what: "Open and recent alerts with severity and duration" },
  { name: "list_monitors", what: "HTTP and heartbeat monitors with state and last check" },
  { name: "recent_events", what: "The event feed, newest first (max 100)" },
  { name: "recent_logs", what: "Stored warning and error logs, scrubbed (max 100)" },
  { name: "list_databases", what: "Databases by alias (db-a ...), provider, state, size" },
  { name: "get_advisor", what: "Today's recommendations" },
  { name: "list_pending_questions", what: "Questions the owner asked with Ask AI, waiting for an answer" },
  { name: "submit_ai_note", what: "Post a note on an app or the console (needs write:notes)", write: true },
  { name: "answer_question", what: "Answer a pending question (needs write:notes)", write: true },
];

// For an agent that works on the owner's code: how to reach Watchbell. Gemini only.
export function agentPrompt(origin: string, model: string = DEFAULT_MODEL): string {
  return `You can use Watchbell, my monitoring console.
1. AI models: an OpenAI-compatible API at ${aiBaseUrl(origin)}
   Auth: "Authorization: Bearer $WATCHBELL_API_KEY". Read the key from the environment; never print, log or commit it.
   Send "X-Client: <your-name>/<version>" on every request so Watchbell shows you by name.
   List models with GET /models. Default model: ${model}. On HTTP 429, wait Retry-After seconds, then retry once.
2. Console data (read-only): the MCP server at ${mcpUrl(origin)} with the same key (needs read:status).
   Tools: ${MCP_TOOLS.filter((t) => !t.write).map((t) => t.name).join(", ")}.
   Or plain HTTP: GET ${base(origin)}/api/v1/status.
Nothing in Watchbell can be changed through this key (a key with write:notes may only post notes and answers with submit_ai_note and answer_question). Database names are aliases (db-a, db-b); don't guess the real ones.`;
}

// The Antigravity Automation that watches the apps once a day (owner 13 Oct).
export function automationPrompt(origin: string): string {
  return `Schedule: every day at 08:00 (${timeZone()}).
Use the MCP server "watchbell" (${mcpUrl(origin)}). Steps:
1. Call list_apps.
2. For every app whose state isn't "running", call get_app with its id.
3. If every app is running, stop without writing anything.
4. Otherwise call submit_ai_note once per affected app:
   title: "<app>: <what is wrong>" (max 120 characters)
   body: 3-6 short markdown bullets: what Watchbell shows, the likely cause, the remedy from get_app first, then your own suggestion. Max 4 KB.
   severity: "crit" if the app is down, "warn" if degraded, else "info"
   app: the app id
   model: "${AGENT_MODEL}"
Don't include URLs, emails, keys or database names other than the aliases Watchbell gives you.`;
}

// The second automation: the console's "Ask AI" inbox.
export function questionsPrompt(origin: string): string {
  return `Schedule: every 15 minutes (or whenever you are open).
Use the MCP server "watchbell" (${mcpUrl(origin)}). Steps:
1. Call list_pending_questions. If it is empty, stop.
2. For each question, use get_app, list_alerts or the other read tools if you need facts, then call answer_question:
   id: the question's id
   answer: markdown, short and concrete: what is wrong, the likely cause, the remedy. Max 8 KB.
   model: "${AGENT_MODEL}"
Answer only from what Watchbell returns; say so when the data doesn't cover the question.
Don't include URLs, emails, keys or database names other than the aliases Watchbell gives you.`;
}

// The daily automation without its "Schedule:" line: cron on a server provides the schedule.
export function headlessPrompt(origin: string): string {
  return automationPrompt(origin).split("\n").slice(1).join("\n");
}

// "Run on a server (24/7)": a headless VM (reached over SSH, for example through Tailscale) that only needs outbound HTTPS.
// Watchbell never connects to it. The ping URL's token is the one shown when the heartbeat monitor is created.
export function serverSetup(origin: string): CodeTab[] {
  const url = mcpUrl(origin);
  const site = base(origin);
  // verified 2026-10-13: https://docs.openclaw.ai/cli/mcp/transports (url, transport streamable-http, headers) and
  // https://docs.openclaw.ai/gateway/configuration/environment-variables.md (${VAR} in config strings, read from the
  // environment or ~/.openclaw/.env). The docs don't name MCP headers as a place where ${VAR} applies: doctor/probe check it.
  const claw = `# OpenClaw on ${SNIPPETS_COPY.host} (SSH in first). The key lives in OpenClaw's own env file, not in the command.
mkdir -p ~/.openclaw && touch ~/.openclaw/.env && chmod 600 ~/.openclaw/.env
echo 'WATCHBELL_API_KEY=${KEY_PLACEHOLDER}' >> ~/.openclaw/.env

openclaw mcp set watchbell '{
  "url": "${url}",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer \${WATCHBELL_API_KEY}" }
}'

# doctor warns about a literal secret; probe opens a live connection and lists the tools
openclaw mcp doctor watchbell
openclaw mcp probe watchbell
# If probe answers 401, the variable didn't resolve: put the key into the header by hand (Bearer wb_...) and run set again.`;
  // verified 2026-10-13: https://geminicli.com/docs/tools/mcp-server/ (httpUrl, headers, trust),
  // https://geminicli.com/docs/reference/configuration/ ($VAR / \${VAR} in settings.json strings), https://geminicli.com/docs/cli/headless/ (-p).
  const gemini = `# Gemini CLI on ${SNIPPETS_COPY.host}: the key in a private env file ...
umask 077 && echo 'export WATCHBELL_API_KEY=${KEY_PLACEHOLDER}' > ~/.watchbell.env

# ... and the server in ~/.gemini/settings.json (settings.json expands $VAR). "trust" skips the per-call
# confirmation, which a headless run can't answer; the key's scopes are what limit the agent.
{
  "mcpServers": {
    "watchbell": {
      "httpUrl": "${url}",
      "headers": { "Authorization": "Bearer $WATCHBELL_API_KEY" },
      "trust": true
    }
  }
}

# Check once by hand
. ~/.watchbell.env && gemini -m ${AGENT_MODEL} -p "Call list_apps on the watchbell MCP server and say how many apps are running."`;
  const cron = SNIPPETS_COPY.cronTab(headlessPrompt(origin), AGENT_MODEL);
  const beat = `# crontab -e: tell Watchbell ${SNIPPETS_COPY.host} is alive, every 5 minutes.
# <token> is shown once when you add the heartbeat (Uptime > Add monitor > Heartbeat).
*/5 * * * * curl -fsS -m 10 --retry 2 ${site}/api/ping/<token> > /dev/null`;
  return [...SNIPPETS_COPY.serverTabs(url, KEY_PLACEHOLDER, AGENT_MODEL), ["OpenClaw", claw], ["Gemini CLI", gemini], ["Cron: automations", cron], ["Cron: heartbeat", beat]];
}
