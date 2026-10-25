import type {
  EnvCopy,
  ActionsCopy, AiCopy, AskCopy, AssistCopy, BannerCopy, ConnectCopy, DepsCopy, DevOnlyCopy, KeysCopy, McpCopy, OpenApiCopy,
  PlaygroundCopy, ProvidersCopy, SnippetsCopy, UptimeCopy, UsageCopy, WelcomeCopy, WhyCopy,
} from "./edition-types";

// The open source edition's wording (exported as edition.ts): the same names and shapes as the private edition's
// (edition-types.ts), in neutral words. Auto-actions are their own feature here, agents are any MCP client the user
// connects, and a self-hosted Watchbell costs nothing. Pure and client-safe.

export const DEPS_COPY: DepsCopy = {
  prApproved: "This PR was opened by Watchbell after the owner approved the **Open package update PR** proposal in Watchbell.",
  cardProposes: "Auto-actions propose an update pull request for high and critical ones.",
  lockfileIntro: "Update PRs get their package-lock.json from a GitHub Actions run in your own small repository (free; runs on GitHub, install scripts off). Set it up once:",
  githubWriteDetail: "Contents and Pull requests write are used only when you approve a PR in Auto-actions",
};

export const ACTIONS_COPY: ActionsCopy = {
  proposedBy: (areaLabel) => areaLabel,
  auditPrefix: "Auto-actions: ",
  autoRunSaved: "Auto-actions saved.",
  settingsAudit: {
    autoRun: "Settings: auto-run changed",
    autoRollback: "Settings: auto-rollback changed",
    autoSecurity: "Settings: automatic security fixes changed",
  },
  telegramDecided: (verb, title) => `Proposal ${verb} from Telegram: ${title}`,
  approvalsOff: "Approval buttons are off. Notices keep their link to Auto-actions.",
  notifyFallback: { en: "Watchbell", id: "Watchbell" },
  logTag: "auto-actions",
};

export const KEYS_COPY: KeysCopy = {
  writeNotesLong: "Off unless you tick it. Lets an agent post AI notes (MCP tool submit_ai_note) that show on Overview and the app page, and answer the questions you ask with Ask AI (MCP tool answer_question). It can't write anything else.",
  pinMessage: "Only Gemini models (names starting with gemini), or a model of this custom provider (listed or added on Models).",
  namePlaceholder: "my-agent",
};

export const PROVIDERS_COPY: ProvidersCopy = {
  noGoogleModels: (name) => `${name} answered but offers no Google text models (Gemini or Gemma).`,
  onlyGoogleOffered: "Only Google models (Gemini, Gemma on Workers AI) can be offered.",
  modelsLine: "Google only: gemini-* and Gemma (@cf/google/gemma-*) on Workers AI.",
  localUrl: "Outside self-host mode Watchbell can't reach your computer or network. Use a public https:// URL.",
  baseUrlHelp: {
    cloud: "HTTPS only. Must answer GET /models.",
    selfhost: "Any OpenAI-compatible server that answers GET /models. http:// on your own machine or network works too (for example Ollama at http://localhost:11434/v1).",
  },
  keyHelp: {
    cloud: "Encrypted before it's stored. Never shown again, never sent to the browser.",
    selfhostCustom: "Optional for a server on your own machine or network (Ollama, LM Studio). If you enter one, it's encrypted before it's stored and never shown again.",
  },
  noKey: "No key",
};

export const AI_COPY: AiCopy = {
  overviewSub: "Apps and agents call Watchbell with their own console keys. Gemini CLI, OpenClaw and other MCP clients read the console over MCP; an API provider you connect (Gemini) answers chat completions. Watchbell applies each key's limit and shows who is calling.",
  overviewNoProvider: ", or connect an agent over MCP.",
  promptHint: "Paste this into Gemini CLI, OpenClaw or another agent so it knows how to reach Watchbell.",
  connectHint: "Gemini CLI, OpenClaw and other MCP clients: config snippets, the tools they get and the automation prompts.",
  clientExamples: "gemini-cli, openclaw",
  modelsReadFailed: "reading the agent models failed",
  defaultModelReadFailed: "reading the agent default model failed",
  palette: { connectKeywords: [] },
};

export const ASK_COPY: AskCopy = {
  empty: "Ask one above, or from an app's Why dialog. Answers come from your AI providers. Questions are kept 7 days.",
  agModelSuffix: " (agent)",
  waiting: "Waiting for an answer…",
  hint: "Answers come from your AI providers, here in a few seconds. Kept 7 days.",
};

export const PLAYGROUND_COPY: PlaygroundCopy = {
  hint: "via an agent · ~10–40 s",
  subAgent: "Try a model with your owner session. Provider models answer in seconds and nothing is stored. Agent models answer through the AI inbox in about 10–40 s; those questions also show on AI › Ask.",
  giveUp: "No answer after 10 minutes. It will still show on AI › Ask when the agent answers.",
  emptyAnswer: "(The agent answered without text.)",
  answerMeta: (model, secs) => `${model} · agent · ${secs} s`,
  expired: "The agent didn't answer this question in time.",
  notTaken: "The agent didn't take the question. Try again.",
  groupLabel: "Agent",
  sending: "Sending to the agent…",
  thinking: "The agent is thinking…",
  howTitle: "How an agent answers",
  howBody: "Your question goes to the AI inbox; your agent checks it, reads the console over MCP and answers, usually in about 10–40 s.",
};

export const USAGE_COPY: UsageCopy = {
  sub: "Model work through Watchbell: calls to your own provider keys, and the runs your agents report over MCP. Token counts are the ones each source reports.",
  agentRequests: "agent runs",
  costAgents: "Agents: billed by their own plans",
  quotaTitle: "Agent quota (estimate)",
  quotaNote: "Estimate from runs Watchbell made. Use of the same account elsewhere isn't counted; the agent's own numbers are in its app.",
  emptyRecent: "Requests appear here once an app or an agent calls a model through Watchbell.",
  graphLabel: "Agents",
  graphSub: "reported over MCP",
  providerName: "Agent runs · reported over MCP",
  limitsAudit: "Agent quota estimates changed",
};

export const BANNER_COPY: BannerCopy = {
  agentTitle: (n) => `An agent is connected over MCP (${n} model${n === 1 ? "" : "s"}).`,
  agentBody: "Ask, the Playground and POST /api/v1/ai/questions go to the agent. Only real-time /api/v1/ai/chat needs a provider.",
  noneBody: "Calls to /api/v1/ai answer 503 provider_not_connected, and Ask AI and summaries need a provider too. MCP still works.",
  infoAgentTitle: "An agent is connected over MCP; a provider here is only for instant answers.",
  infoAgentBody: "Connect Gemini or Workers AI if you want answers in seconds (real-time /api/v1/ai/chat). Ask and the Playground already work through the agent.",
  infoBody: "Agents over MCP work without one. Connect Gemini or Workers AI for answers in seconds (Ask AI, the Why dialog, summaries).",
};

export const WHY_COPY: WhyCopy = {
  ask: "Ask the agent",
  askAgain: "Ask the agent again",
  keptNote: "A question for the agent is kept for 7 days.",
  answeredFallback: "Agent",
  answerTitle: "The agent’s answer",
  expired: (ago) => `The last question to the agent (${ago}) got no answer within 7 days.`,
  recConnect: "Connect a provider or an agent to get AI notes",
};

export const ASSIST_COPY: AssistCopy = {
  noProvider: "No AI provider is connected. Connect one under AI Gateway › Bring your own key.",
  queuedAudit: (what) => `Question for the agent queued: ${what}`,
  alreadyWaiting: "That question is already waiting for the agent.",
  sentApp: "Sent. The agent answers the next time it checks in; the answer shows here and on AI › Ask.",
  sentGeneral: "Sent. The agent answers the next time it checks in.",
  tooMany: (n) => `${n} questions are already waiting for the agent. Let it answer some first.`,
};

export const CONNECT_COPY: ConnectCopy = {
  automationsBelow: "the automations below",
  automationTitle: "Scheduled automation",
  automationLead: "A scheduled run in your agent (Gemini CLI, OpenClaw or another MCP client), with the agent's own subscription (Watchbell can't see or spend it).",
  notSupportedLead: "Signing in with a Gemini or other consumer account to borrow its quota.",
};

export const SNIPPETS_COPY: SnippetsCopy = {
  mcpTabs: () => [],
  serverTabs: () => [],
  host: "the server",
  cronTab: (headless, model) => `# The daily check as a file the cron job reads (the prompt from "Scheduled automation", without its Schedule line)
cat > ~/watchbell-daily.txt <<'PROMPT'
${headless}
PROMPT

# crontab -e: every 6 hours. cron has a short PATH, so use full paths (which gemini).
0 */6 * * * . $HOME/.watchbell.env && /usr/local/bin/gemini -m ${model} -p "$(cat $HOME/watchbell-daily.txt)" >> $HOME/watchbell-gemini.log 2>&1`,
};

export const MCP_COPY: McpCopy = {
  pendingModel: "the agent model id to answer with",
  instructionsTail: [
    "Around every run you make for Watchbell call report_activity (the run when it starts, null when it ends) and",
    "afterwards report_usage with the run's token usage as your agent reports it.",
  ],
  usageSource: "your agent's own usage report",
  reportUsage: "After each run you make for Watchbell (answering questions, the advisor), report its token usage as your agent reports it: new input tokens → inputTokens, cache read tokens → cachedTokens, output tokens → outputTokens, thinking tokens → thinkingTokens; the run's duration in milliseconds → durationMs. status: ok, error, or limit (quota hit). 1–20 runs per call, each at most 24 h old. Returns `recorded`. At most 120 reports per key per hour.",
  reportActivity: "Tell Watchbell when a run starts (`running`: model, purpose, startedAt) and when it ends (`running: null`), so the owner sees it live on AI › Usage. A run older than 15 minutes is shown as idle. At most 240 reports per key per hour.",
};

export const OPENAPI_COPY: OpenApiCopy = {
  noteSource: "gemini-cli",
  modelsAgSentence: "",
  agModelExamples: [],
  askAgSentence: " An agent model (ag/<id>, listed only while an agent reports its models) is queued for that agent instead: 202 pending, poll pollUrl until status is answered or expired (at most 20 wait, 429 quota_exceeded).",
  queued: "Queued for an agent (an ag/<id> model; or the same question from this key was already waiting). Poll pollUrl.",
  answeredByAgent: "an agent",
  answeredByClient: "gemini-cli/1.0",
  adviceAgent: "an agent such as Gemini CLI",
  mcpClients: "Gemini CLI, OpenClaw and others",
  advisorExample: {
    name: "Assistant prompt from another app",
    system: "You are a release assistant for a small team. Answer in two short paragraphs.",
    user: "Which of my apps should I look at first this morning?",
  },
  adviceFor: "Ask",
};

export const ENV_COPY: EnvCopy = {
  notSet: (names, plural = false) => `${names} ${plural ? "aren't" : "isn't"} set in your .env file (~/.watchbell/.env with npm, app/.env with the installers; restart Watchbell after adding ${plural ? "them" : "it"}).`,
  setting: "a setting in your .env file (~/.watchbell/.env with npm, app/.env with the installers)",
  keyHome: "your .env file (OPS_ENCRYPTION_KEY; ~/.watchbell/.env with npm, app/.env with the installers)",
  checkWhere: "in your .env file (~/.watchbell/.env with npm, app/.env with the installers)",
  apply: "restart Watchbell",
};

export const DEV_ONLY_COPY: DevOnlyCopy = { env: [] };

export const WELCOME_COPY: WelcomeCopy = {
  amount: "Free",
  note: "Self-hosting costs nothing: Watchbell runs on your own computer or server, with its own built-in database.",
  free: [
    ["Your computer or server", "The console and every check"], ["Built-in database", "No database account needed"],
    ["Telegram", "Alerts (optional)"], ["Google Drive", "Monthly backups (optional)"],
  ],
  alertsStep: { text: "Set up alerts", href: "/alerts" },
};

export const UPTIME_COPY: UptimeCopy = {
  sub: {
    cloud: "HTTP checks run every minute; heartbeats wait for your own jobs to ping. cron-job.org calls the collector, and Upstash QStash checks every 5 minutes that it is still running.",
    selfhost: "HTTP checks run every minute; heartbeats wait for your own jobs to ping. Watchbell's built-in scheduler runs them while Watchbell is running.",
  },
};
