# AI

Watchbell has no AI of its own and no AI account behind it. Every AI feature uses **your own provider key**, so it
costs nothing until you add one, and then it uses your provider's quota. Everything here is under **AI & API › AI
Gateway** (owner only).

- [Add a provider](#add-a-provider)
- [What uses AI](#what-uses-ai)
- [Models, quota and logs](#models-quota-and-logs)
- [API keys](#api-keys)
- [The gateway: AI for your own apps](#the-gateway-ai-for-your-own-apps)
- [MCP: connect an AI agent](#mcp-connect-an-ai-agent)
- [What leaves your machine](#what-leaves-your-machine)

## Add a provider

Open **AI Gateway › Bring your own key** and connect one of:

| Provider | What you paste | Where to get it |
|---|---|---|
| Google Gemini | An AI Studio API key (starts with `AQ.` or `AIza`) | https://aistudio.google.com/apikey |
| Cloudflare Workers AI | An API token with **Workers AI: Read**, and your account ID (on the Workers AI page) | https://dash.cloudflare.com/profile/api-tokens |
| Custom OpenAI-compatible (under Advanced) | The server's base URL and an API key | Any server that speaks the OpenAI chat completions API and answers `GET /models`, on the internet or on your own machine or network (Ollama, LM Studio and others) |

Notes:

- Watchbell offers Google's models: Gemini from Google, and Google's Gemma models on Cloudflare Workers AI. A custom
  server offers every model it lists.
- A custom server can use `http://` or `https://` on any port: a public address, or one on your own machine or network
  (`localhost`, `127.x`, `10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `*.local`). For example Ollama at
  `http://localhost:11434/v1` or LM Studio at `http://localhost:1234/v1`. Link-local and cloud metadata addresses
  (`169.254.x`) are refused.
- Local servers usually need no key, but the form asks for one of at least 8 characters: type any placeholder, such as
  `ollama-local`.
- One connection is the default. Keys are encrypted with `OPS_ENCRYPTION_KEY`, never sent to the browser and never
  logged, and Watchbell never rotates between accounts.

Until a provider is connected, every AI Gateway page shows a "No provider connected" banner and the AI features below
stay quiet.

## What uses AI

Once a provider is connected:

- **Ask** (AI Gateway › Ask): questions about your console ("which apps were down this week, and why?"), answered by
  your provider from a scrubbed snapshot of your console data. Questions are kept 7 days.
- **Advisor notes**: twice a day, at 07:00 and 19:00 WIB, one provider call writes short notes about the apps that need
  attention. They show on Overview and the app pages. Switch them off, or pick their model, on **AI Gateway › Models**.
- **Summaries and explanations**: a short daily summary of the recommendations, and an AI explanation on an app's
  problems, each made with your default model.
- **Playground**: try a model with your owner session. "Plain" sends only your messages; "Ask the console" adds a
  scrubbed snapshot of your apps. Nothing is stored.

## Models, quota and logs

- **Models** lists the models each connected provider offers (its `/models`). Turn a model off and requests for it are
  refused with `400 model_not_enabled`. Model ids are `provider/model`; a bare id goes to the default provider.
- **Quota** shows what each provider did through Watchbell and each console key's own limit. Gemini and Cloudflare
  don't report their limits, so Watchbell counts requests against limits you enter for the connection.
- **Usage** shows token counts (input, cached, output) as each provider reports them.
- **Logs** keeps metadata only: time, key, client, model, tokens, latency and result. Prompts and answers are never
  stored. Kept 30 days.

## API keys

Your own apps and AI agents talk to Watchbell with **console API keys** (AI Gateway › API keys). A key starts with
`wp_`, is shown once, and Watchbell keeps only its SHA-256 hash and a short prefix to tell keys apart. Revoking a key stops it within a minute.

Each key has scopes:

| Scope | Allows |
|---|---|
| `ai:invoke` | Chat completions and the model list through your provider connections (the default) |
| `read:status` | Read-only console data: `GET /api/v1/status` and the MCP server. Database names are aliases; no URLs, emails or secrets |
| `write:notes` | Off unless you tick it. Lets an agent post AI notes and answer questions from Ask. Nothing else |

You also choose an expiry (7 days to never; 90 days by default) and a rate limit per minute (20 by default, at most
600). At most 20 keys can be active. **API explorer** documents every endpoint and lets you try them with a key.

## The gateway: AI for your own apps

Watchbell exposes an OpenAI-compatible API in front of your provider connections. Point an OpenAI client at
`<SITE_URL>/api/v1/ai` with a key that has `ai:invoke`:

```bash
curl http://localhost:3100/api/v1/ai/chat/completions \
  -H "Authorization: Bearer $WATCHBELL_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Client: my-app/1.0" \
  -d '{"model": "gemini/gemini-3.8-flash", "messages": [{"role": "user", "content": "Hello"}]}'
```

Use a model id from AI Gateway › Models; the example asks a Gemini model on a connection named gemini.
`GET /api/v1/ai/models` lists the models your key can use. Watchbell applies the key's rate limit, records the call in Logs and shows the caller under Agents. The `X-Client` header (optional)
names your app there.

On a laptop, the gateway is reachable only from that machine unless you turn on [LAN access](configuration.md#lan-access).

## MCP: connect an AI agent

AI agents that support the Model Context Protocol (MCP) can read your console through Watchbell's MCP server:

- URL: `<SITE_URL>/api/v1/mcp` (Streamable HTTP), for example `http://localhost:3100/api/v1/mcp`.
- Header: `Authorization: Bearer <key>`, with a key that has `read:status`.

**AI Gateway › Connect an agent** shows ready-to-paste configuration for common clients. For example, Gemini CLI:

```bash
gemini mcp add --transport http watchbell http://localhost:3100/api/v1/mcp \
  --header "Authorization: Bearer $WATCHBELL_API_KEY"
```

A client that only speaks stdio can use `mcp-remote`:

```bash
npx mcp-remote http://localhost:3100/api/v1/mcp --header "Authorization: Bearer $WATCHBELL_API_KEY"
```

The agent gets read-only tools (`list_apps`, `get_app`, `list_alerts`, `list_monitors`, `recent_events`,
`recent_logs`, `list_databases`, `get_advisor`, `list_pending_questions`) and, only with `write:notes`, tools to post
notes and answer questions. It can't change anything else. Agents appear under **Agents** after their first request,
named after their MCP client name, the `X-Client` header or their User-Agent.

## What leaves your machine

AI features send your provider a **scrubbed** snapshot of console data: databases by alias (db-a, db-b), no emails,
no tokens, no connection strings. Requests from your own apps through the gateway are forwarded as they are. Nothing
goes to the Watchbell project.
