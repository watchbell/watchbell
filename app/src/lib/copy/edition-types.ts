// The shape of the edition wording (open source plan 6, ruling P17). edition.ts holds the private edition's text (prod,
// unchanged); edition.public.ts holds the open source edition's (the export replaces edition.ts with it). Both are
// typed against these, so a missing or misshapen entry fails tsc in the repo, not only in the export. Pure, client-safe.

export type CodeTabCopy = [label: string, code: string];

export type DepsCopy = {
  prApproved: string; // bump.ts: the update PR body's first line after a manual approval
  cardProposes: string; // apps/[id]/deps-card.tsx
  lockfileIntro: string; // settings/actions-lockfile-card.tsx
  githubWriteDetail: string; // lib/providers/test-connection.ts: the PR-write token's test result
};

export type ActionsCopy = {
  proposedBy: (areaLabel: string) => string; // private/actions/areas.ts
  auditPrefix: string; // an auto-run's audit message prefix
  autoRunSaved: string; // Settings › Auto-actions toast
  settingsAudit: { autoRun: string; autoRollback: string; autoSecurity: string };
  telegramDecided: (verb: string, title: string) => string; // an approval from Telegram, audited
  approvalsOff: string; // Alerts › Telegram approvals switched off
  notifyFallback: { en: string; id: string }; // a notice's proposer when the proposal has none
  logTag: string; // server log prefix ("<tag>/proposals failed")
};

export type KeysCopy = { writeNotesLong: string; pinMessage: string; namePlaceholder: string };

export type ProvidersCopy = {
  noGoogleModels: (name: string) => string;
  onlyGoogleOffered: string;
  modelsLine: string; // AI › Bring your own key › Models
  localUrl: string; // a custom provider on a local or private host, outside self-host mode
  baseUrlHelp: { cloud: string; selfhost: string }; // the custom provider dialog's Base URL help, by runtime mode
  keyHelp: { cloud: string; selfhostCustom: string }; // the dialog's key help: cloud/presets, and a self-host custom provider
  noKey: string; // the providers table's key column for a connection saved without a key (self-host, local server)
};

export type AiCopy = {
  overviewSub: string;
  overviewNoProvider: string; // after the "Connect a provider" link
  promptHint: string;
  connectHint: string;
  clientExamples: string; // AI › Agents: clientInfo names
  modelsReadFailed: string; // server log
  defaultModelReadFailed: string; // server log
  palette: { connectKeywords: string[] }; // the "Connect an agent" palette entry's extra keywords
};

export type AskCopy = {
  empty: string;
  agModelSuffix: string;
  waiting: string;
  hint: string;
};

export type PlaygroundCopy = {
  hint: string;
  subAgent: string;
  giveUp: string;
  emptyAnswer: string;
  answerMeta: (model: string, secs: number) => string;
  expired: string;
  notTaken: string;
  groupLabel: string;
  sending: string;
  thinking: string;
  howTitle: string;
  howBody: string;
};

export type UsageCopy = {
  sub: string;
  agentRequests: string; // "<n> <agentRequests> · <m> providers"
  costAgents: string;
  quotaTitle: string;
  quotaNote: string;
  emptyRecent: string;
  graphLabel: string;
  graphSub: string;
  providerName: string; // AI › Quota: the agent's own row
  limitsAudit: string;
};

export type BannerCopy = {
  agentTitle: (models: number) => string;
  agentBody: string;
  noneBody: string;
  infoAgentTitle: string;
  infoAgentBody: string;
  infoBody: string;
};

export type WhyCopy = {
  ask: string;
  askAgain: string;
  keptNote: string;
  answeredFallback: string;
  answerTitle: string;
  expired: (ago: string) => string;
  recConnect: string; // Overview › Recommendations without a provider
};

export type AssistCopy = {
  noProvider: string;
  queuedAudit: (what: string) => string;
  alreadyWaiting: string;
  sentApp: string;
  sentGeneral: string;
  tooMany: (n: number) => string;
};

export type ConnectCopy = {
  automationsBelow: string;
  automationTitle: string;
  automationLead: string;
  notSupportedLead: string;
};

export type SnippetsCopy = {
  mcpTabs: (url: string, key: string) => CodeTabCopy[]; // config tabs before Gemini CLI
  serverTabs: (url: string, key: string, model: string) => CodeTabCopy[]; // server tabs before OpenClaw
  host: string; // "OpenClaw on <host>"
  cronTab: (headlessPrompt: string, model: string) => string;
};

export type McpCopy = {
  pendingModel: string;
  instructionsTail: string[]; // the MCP server's instructions after the shared lines (joined with spaces)
  usageSource: string; // where an agent's token counts come from (report_usage's token fields)
  reportUsage: string; // report_usage's description
  reportActivity: string; // report_activity's description
};

export type OpenApiCopy = {
  noteSource: string;
  modelsAgSentence: string; // ends with a space when not empty
  agModelExamples: Record<string, unknown>[];
  askAgSentence: string; // starts with a space when not empty
  queued: string;
  answeredByAgent: string;
  answeredByClient: string;
  adviceAgent: string;
  mcpClients: string;
  advisorExample: { name: string; system: string; user: string }; // the chat endpoint's third example
  adviceFor: string; // starts the advice endpoint's second sentence
};

// Where the server's secrets live: the private edition runs on Vercel, the open source one reads app/.env.
export type EnvCopy = {
  notSet: (names: string, plural?: boolean) => string; // "<names> isn't set …" / "… aren't set …"
  setting: string; // "The bot token is <setting> (TELEGRAM_BOT_TOKEN)."
  keyHome: string; // "The key lives in <keyHome>, and …"
  checkWhere: string; // "Check the value <checkWhere>."
  apply: string; // "…, then <apply>."
};

// Env vars only the private edition knows; production warns when one is set (lib/dev-only.ts).
export type DevOnlyCopy = { env: string[] };

export type WelcomeCopy = {
  amount: string;
  note: string;
  free: [name: string, what: string][];
  alertsStep: { text: string; href: string | null };
};

// Uptime's subtitle, by runtime mode: cloud names its external schedulers, self-host (and demo) the built-in one.
export type UptimeCopy = { sub: { cloud: string; selfhost: string } };
