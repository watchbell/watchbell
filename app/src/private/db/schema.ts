import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, date, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ops } from "@/db/schema";
import type { NoteSeverity, ProviderKind, QuestionContextKind, QuestionPurpose, QuestionStatus } from "@/private/ai/types";
import type { ActionArea } from "@/private/actions/areas";
import type { ProposalAction, ProposalRisk, ProposalStatus } from "@/private/actions/proposals-types";
import type { DevNoteStatus, DevTrigger, NewsTopic, OfficeEv, OfficeUsage, ReportRoom, ReportSource, ReportVia } from "./office-types";

// Stage 5c tables (private feature). drizzle.config.ts reads this folder too, so `npm run db:generate` picks them up;
// value checks, RLS and grants are in drizzle/0017_ai_gateway_lockdown.sql.

// Console API keys: the key itself is never stored, only sha256(key) hex and its first 7 chars (R3).
export const apiKeys = ops.table("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").array().notNull(),
  ratePerMin: integer("rate_per_min").notNull().default(20),
  providerId: uuid("provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
  model: text("model"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("api_keys_hash_key").on(t.keyHash)]);

// OpenAI-compatible provider connections (BYOK). The secret is sealed (lib/crypto) in ciphertext/iv (R3).
export const aiProviders = ops.table("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<ProviderKind>().notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(), // presets: fixed; cloudflare: with the account id filled in
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  keyHint: text("key_hint").notNull(), // last 3 chars of the API key/token
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  models: jsonb("models").$type<{ id: string; upstream: string; enabled: boolean; ctx?: number; out?: number; manual?: boolean; lastTest?: { ok: boolean; ms: number; status?: number; error?: string; at: string }; removed?: boolean; removedAt?: string; pending?: boolean; addedAt?: string; manualOff?: boolean }[]>().notNull().default([]),
  limits: jsonb("limits").$type<{ metric: string; scope: string; limit: number; window: "minute" | "day" | "week" }[]>().notNull().default([]),
  lastTestAt: timestamp("last_test_at", { withTimezone: true }),
  lastTestStatus: integer("last_test_status"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Detected callers (R6): one row per (key, client name); key_id null = the console itself.
export const aiAgents = ops.table("ai_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyId: uuid("key_id").references(() => apiKeys.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  clientVersion: text("client_version").notNull().default(""),
  via: text("via").notNull(),
  userAgent: text("user_agent").notNull().default(""),
  displayName: text("display_name"), // owner rename
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  requests: bigint("requests", { mode: "number" }).notNull().default(0),
  tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
  tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
  recent: text("recent").array().notNull().default([]), // ≤ 10 most recent models or MCP tools
});

// Call metadata only, never prompts or completions (R5). Kept 30 days.
export const aiUsage = ops.table("ai_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  keyId: uuid("key_id"),
  agentId: uuid("agent_id"),
  providerId: uuid("provider_id"),
  model: text("model"),
  kind: text("kind").notNull(),
  tool: text("tool"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  latencyMs: integer("latency_ms").notNull(),
  status: integer("status").notNull(),
  errorClass: text("error_class"),
  stream: boolean("stream").notNull().default(false),
  // 0021: Antigravity runs (kind 'agent', MCP report_usage) also carry cached-input and thinking tokens; null otherwise.
  tokensCached: integer("tokens_cached"),
  tokensThinking: integer("tokens_thinking"),
}, (t) => [index("ai_usage_at_idx").on(t.at), index("ai_usage_key_at_idx").on(t.keyId, t.at)]);

// What a provider told us about its limits (headers), or our own counters against owner-entered limits.
export const aiQuota = ops.table("ai_quota", {
  providerId: uuid("provider_id").notNull().references(() => aiProviders.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  metric: text("metric").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }),
  used: integer("used"),
  limit: integer("limit"),
  remaining: integer("remaining"),
  resetAt: timestamp("reset_at", { withTimezone: true }),
  source: text("source").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.providerId, t.scope, t.metric] })]);

// AI notes from agents (R8: the one write under /api/v1, MCP submit_ai_note with write:notes).
export const aiNotes = ops.table("ai_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyId: uuid("key_id").references(() => apiKeys.id, { onDelete: "set null" }),
  source: text("source").notNull(), // detected client name (R6), never from the request body
  appId: text("app_id"), // resolved app id, or null for console-wide notes
  severity: text("severity").$type<NoteSeverity>().notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  model: text("model"), // the model the agent reports (owner 07:35: must pass isAllowedModel)
  client: text("client"), // detected client name/version as shown ("antigravity/1.4")
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  dismissedBy: uuid("dismissed_by"),
}, (t) => [index("ai_notes_created_idx").on(t.createdAt)]);

// Questions the console asks the AI brain (owner 07:35: Antigravity over MCP answers them; API providers optional).
// Bounded like ai_notes; answers only from an allowed (Gemini) model.
export const aiQuestions = ops.table("ai_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contextKind: text("context_kind").$type<QuestionContextKind>().notNull(),
  contextId: uuid("context_id"),
  question: text("question").notNull(), // ≤ 2000 chars
  status: text("status").$type<QuestionStatus>().notNull().default("pending"),
  answer: text("answer"), // ≤ 8000 chars
  answeredByClient: text("answered_by_client"),
  answeredByModel: text("answered_by_model"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  // 0020: the Antigravity model the asker picked (null = the VM's own setting) and why the row exists ('ping' = a
  // model test from the Models page, hidden from the Ask page). Checks are in drizzle/0020_ai_question_models.sql.
  requestedModel: text("requested_model"),
  purpose: text("purpose").$type<QuestionPurpose>().notNull().default("ask"),
}, (t) => [index("ai_questions_status_created_idx").on(t.status, t.createdAt)]);

// Kantor Virtual (owner 14 Oct, 0022): the compact events the Claude Code hook sends (POST /api/v1/office/events,
// write:notes). No prompt, code or tool input: a tool name, an agent type and at most one scrubbed sentence. Kept 24 h
// and at most the newest 5,000 (daily step "office-retention"). Value checks, RLS and grants are in the same migration.
export const officeEvents = ops.table("office_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  session: text("session").notNull(), // ≤ 16
  project: text("project"), // ≤ 80
  agent: text("agent"), // ≤ 40
  agentType: text("agent_type"), // ≤ 60
  ev: text("ev").$type<OfficeEv>().notNull(),
  tool: text("tool"), // ≤ 80
  summary: text("summary"), // ≤ 200, scrubbed
  kind: text("kind"), // ≤ 40, notification type
  spawn: jsonb("spawn").$type<{ type: string; desc: string; bg: boolean }>(),
  usage: jsonb("usage").$type<OfficeUsage>(), // stop / sub_stop: token counts only (0023)
  keyId: uuid("key_id"),
}, (t) => [index("office_events_at_idx").on(t.at)]);

// Kantor Virtual report inbox (owner 14 Oct, 0024): full reports the owner reads in the office. source "patrol" (a
// Patroli round compiled by the Manager) or "manager" (posted by the real Claude Code session, write:notes; key_id is
// that key, for its 30-per-hour limit). Scrubbed text only. Kept 7 days (daily step "office-retention"). Value checks,
// RLS and grants are in the same migration.
export const officeReports = ops.table("office_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source").$type<ReportSource>().notNull(),
  title: text("title").notNull(), // ≤ 120
  body: text("body").notNull(), // ≤ 8000
  rooms: jsonb("rooms").$type<ReportRoom[]>(), // ≤ 8 KB
  model: text("model"), // ≤ 120
  via: text("via").$type<ReportVia>(), // ≤ 40
  usage: jsonb("usage").$type<OfficeUsage>(), // summed token counts
  keyId: uuid("key_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [index("office_reports_at_idx").on(t.at)]);

// Stage 9 slice 1 (owner 15 Oct, 0030): an officer's proposal to run one of the console's existing actions for a firing
// alert; the owner approves or rejects it in the office (proposals-types.ts is the contract). Text is already scrubbed
// (display names / aliases, never an email). `target_ref` is the one provider or console id the action needs besides
// `resource_id` (a monitor id, a Vercel deployment id, a Neon endpoint id or a Supabase ref): never a secret.
// `decided_by` is the deciding member's id. `claimed_at` is set when a run starts, so two processes never run one
// proposal. One open (pending / approved / running) proposal per alert and action (the partial unique index). Value
// checks, RLS and grants are in 0031.
export const actionProposals = ops.table("action_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id"),
  ruleKey: text("rule_key").notNull(),
  room: text("room").$type<ActionArea>().notNull(),
  action: text("action").$type<ProposalAction>().notNull(),
  risk: text("risk").$type<ProposalRisk>().notNull(),
  title: text("title").notNull(), // ≤ 200
  reason: text("reason").notNull(), // ≤ 200
  resourceKind: text("resource_kind"),
  resourceId: uuid("resource_id"),
  resourceName: text("resource_name"), // ≤ 120, a display name or alias
  targetRef: text("target_ref"), // ≤ 120
  proposedBy: text("proposed_by").notNull(), // ≤ 60
  status: text("status").$type<ProposalStatus>().notNull().default("pending"),
  auto: boolean("auto").notNull().default(false),
  result: text("result"), // ≤ 200
  decidedBy: uuid("decided_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("action_proposals_open_alert_action").on(t.alertId, t.action).where(sql`status in ('pending', 'approved', 'running')`),
  index("action_proposals_status_created_idx").on(t.status, t.createdAt),
]);

// Stage 9 slice 3 (owner 16 Oct, 0032): the Dev officer's notes (dev-notes-types.ts is the contract). One row per code
// check of an app: queued → running → done | failed | skipped. Text is scrubbed and redacted before it is stored; the
// code itself is never stored. `app_id` is the app's resource id, `proposal_id` the LogErrorSpike proposal it was asked
// for (at most one note per proposal: the partial unique index). Kept 30 days (daily step). Checks, RLS and grants in 0033.
export const devNotes = ops.table("dev_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: uuid("app_id").notNull(),
  proposalId: uuid("proposal_id"),
  trigger: text("trigger").$type<DevTrigger>().notNull(),
  status: text("status").$type<DevNoteStatus>().notNull().default("queued"),
  repo: text("repo"), // ≤ 201, "owner/name"
  ref: text("ref"), // ≤ 64
  question: text("question").notNull(), // ≤ 200
  summary: text("summary"), // ≤ 400
  cause: text("cause"), // ≤ 200
  files: jsonb("files").$type<{ path: string; why: string }[]>().notNull().default([]),
  patch: text("patch"), // ≤ 4000
  confidence: text("confidence").$type<"low" | "medium" | "high">(),
  model: text("model"), // ≤ 120
  error: text("error"), // ≤ 200
  requestedBy: uuid("requested_by"), // the member who asked (manual); null for auto
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("dev_notes_proposal_one").on(t.proposalId).where(sql`proposal_id is not null`),
  index("dev_notes_created_idx").on(t.createdAt),
  index("dev_notes_app_status_idx").on(t.appId, t.status),
]);

// Stage 10 (owner 16 Oct, 0040): Berita Dunia's headlines, titles and links only (never an article): at most 10 per
// topic per WIB day, one row per link per day (the unique index), kept 14 days (daily step "office-news-retention").
// `day` is the WIB day the brief was written for. Value checks, RLS and grants are in 0041.
export const newsItems = ops.table("news_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  day: date("day", { mode: "string" }).notNull(),
  topic: text("topic").$type<NewsTopic>().notNull(),
  title: text("title").notNull(), // ≤ 200
  url: text("url").notNull(), // ≤ 1000, http(s)
  source: text("source"), // ≤ 100, the publisher's name
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("news_items_url_day").on(t.url, t.day),
  index("news_items_day_topic_idx").on(t.day, t.topic),
]);
