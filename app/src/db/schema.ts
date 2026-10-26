import { sql } from "drizzle-orm";
import type { PrStage } from "@/lib/deps/pr-watch";
import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ROLES } from "@/lib/roles";
import type { Finding, SecurityStatus } from "@/lib/security/types";
import { STATES } from "@/lib/status";

export const ops = pgSchema("ops");

export const roleEnum = ops.enum("role", ROLES);
export const providerEnum = ops.enum("provider", ["vercel", "supabase", "neon", "firebase", "cloudflare", "drive", "github", "github_write", "turso", "upstash"]);
export const accountStatusEnum = ops.enum("account_status", ["ok", "error"]);

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const members = ops.table("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique(),
  email: text("email").notNull().unique(),
  role: roleEnum("role").notNull(),
  invitedBy: uuid("invited_by"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  ...stamps,
});

// The sign-in token itself lives in Supabase Auth. This row records who was invited, as what, and until when.
export const invites = ops.table(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...stamps,
  },
  (t) => [uniqueIndex("invites_open_email").on(t.email).where(sql`accepted_at is null`)],
);

export const accounts = ops.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    label: text("label").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    credentialIv: text("credential_iv").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    credentialKind: text("credential_kind").notNull(),
    scopeNote: text("scope_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: accountStatusEnum("status").notNull().default("ok"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    watchNew: boolean("watch_new").notNull().default(false),
    ...stamps,
  },
  (t) => [uniqueIndex("accounts_provider_label").on(t.provider, t.label)],
);

export const settings = ops.table("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...stamps,
});

// Fixed-window counters for sign-in, credential tests and MFA codes. `key` is "<limit>:<sha256 of subject>".
export const rateLimits = ops.table(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export const resourceKindEnum = ops.enum("resource_kind", ["app", "supabase_project", "neon_project", "neon_branch", "firestore", "zone", "domain", "dns_record", "turso_database", "upstash_redis", "d1_database"]);
export const stateEnum = ops.enum("state", STATES);
export const eventTypeEnum = ops.enum("event_type", ["deployment", "monitor", "database", "system", "action"]);
export const triggerEnum = ops.enum("collector_trigger", ["cron_job_org", "qstash", "vercel_cron", "manual"]);

// Everything Sync finds. `monitored` is the owner's tick in the Sync dialog; `gone_at` marks rows the provider stopped returning.
export const resources = ops.table(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    kind: resourceKindEnum("kind").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    monitored: boolean("monitored").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    goneAt: timestamp("gone_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ...stamps,
  },
  (t) => [
    uniqueIndex("resources_account_kind_external").on(t.accountId, t.kind, t.externalId),
    index("resources_account_kind").on(t.accountId, t.kind),
  ],
);

// Latest known state per resource (one row each).
export const snapshots = ops.table("snapshots", {
  resourceId: uuid("resource_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
  state: stateEnum("state").notNull().default("unknown"),
  stateSince: timestamp("state_since", { withTimezone: true }).notNull().defaultNow(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
});

// HTTP checks. The live state sits on the row so the Uptime page needs no aggregation for "now".
export const monitors = ops.table(
  "monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    expectedStatus: integer("expected_status").notNull().default(200),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    intervalS: integer("interval_s").notNull().default(60),
    paused: boolean("paused").notNull().default(false),
    // The owner's own pause (Uptime → Pause). `paused` above belongs to Sync (app unwatched); Sync never clears this one.
    ownerPaused: boolean("owner_paused").notNull().default(false),
    state: stateEnum("state").notNull().default("unknown"),
    stateSince: timestamp("state_since", { withTimezone: true }).notNull().defaultNow(),
    failStreak: integer("fail_streak").notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    lastLatencyMs: integer("last_latency_ms"),
    // 5b. A heartbeat monitor (kind 'heartbeat') is pinged by the owner's job instead of fetching a URL; its url is
    // "heartbeat:" + a badge-style slug of its name, so (resource_id, url) keeps one heartbeat name per app.
    kind: text("kind").$type<"http" | "heartbeat">().notNull().default("http"),
    name: text("name"), // heartbeat display name ("backup job"); null for HTTP
    bodyContains: text("body_contains"),
    jsonPath: text("json_path"),
    jsonEquals: text("json_equals"),
    lastError: text("last_error"),
    tokenHash: text("token_hash"), // heartbeat: sha256 hex of the ping token
    periodS: integer("period_s"),
    graceS: integer("grace_s"),
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
    lastPingKind: text("last_ping_kind").$type<"ok" | "fail" | "start">(),
    ...stamps,
  },
  (t) => [
    uniqueIndex("monitors_resource_url").on(t.resourceId, t.url),
    uniqueIndex("monitors_token_hash").on(t.tokenHash).where(sql`token_hash is not null`),
  ],
);

export const checks = ops.table(
  "checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    inMaintenance: boolean("in_maintenance").notNull().default(false),
  },
  // checks_at (perf P4, 0013): Overview health reads the last 24 h of every monitor; the daily rollup and retention
  // read by time alone.
  (t) => [index("checks_monitor_at").on(t.monitorId, t.at.desc()), index("checks_at").on(t.at)],
);

// Per monitor (ruling: uptime and response are monitor facts; app numbers aggregate its monitors).
export const rollupsHourly = ops.table(
  "rollups_hourly",
  {
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    checks: integer("checks").notNull(),
    failures: integer("failures").notNull(),
    p50Ms: integer("p50_ms"),
    p95Ms: integer("p95_ms"),
    maxMs: integer("max_ms"),
    status5xx: integer("status_5xx").notNull().default(0),
    maintenance: integer("maintenance").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.hour] })],
);

// U5: checks keep running inside a window but don't count in uptime % and open no alerts. WIB; weekly windows repeat
// every 7 × 24 h from starts_at.
export const maintenanceWindows = ops.table("maintenance_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").$type<"all" | "app" | "monitor">().notNull(),
  resourceId: uuid("resource_id").references(() => resources.id, { onDelete: "cascade" }),
  monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  durationMin: integer("duration_min").notNull(),
  weekly: boolean("weekly").notNull().default(false),
  note: text("note"),
  createdBy: uuid("created_by"),
  ...stamps,
});

// R3: an Advisor item hidden by its key until 30 days after dismissed_at.
export const recommendationDismissals = ops.table("recommendation_dismissals", {
  key: text("key").primaryKey(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull(),
  dismissedBy: uuid("dismissed_by"),
});

// U6: the public status page (one for now) and the monitors on it, under the owner's own names.
export const statusPages = ops.table("status_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  announcement: text("announcement"),
  published: boolean("published").notNull().default(false),
  ...stamps,
});

export const statusPageMonitors = ops.table(
  "status_page_monitors",
  {
    pageId: uuid("page_id").notNull().references(() => statusPages.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    badgeKey: text("badge_key").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.monitorId] }), uniqueIndex("status_page_monitors_badge").on(t.pageId, t.badgeKey)],
);

export const deployments = ops.table(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull().unique(),
    state: text("state").notNull(),
    target: text("target"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    source: text("source"),
    url: text("url"),
    buildingAt: timestamp("building_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAtProvider: timestamp("created_at_provider", { withTimezone: true }).notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    isPreviousProduction: boolean("is_previous_production").notNull().default(false),
    ...stamps,
  },
  // deployments_created (perf P4, 0013): the Deployments page (newest 200 of all apps), Overview's ongoing builds and
  // deploy count, and retention all read by time across apps.
  (t) => [index("deployments_resource_created").on(t.resourceId, t.createdAtProvider.desc()), index("deployments_created").on(t.createdAtProvider)],
);

export const events = ops.table(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    resourceId: uuid("resource_id").references(() => resources.id, { onDelete: "set null" }),
    type: eventTypeEnum("type").notNull(),
    kind: stateEnum("kind").notNull(),
    message: text("message").notNull(),
    detail: text("detail"),
    actorUserId: uuid("actor_user_id"),
    // R2: a reason code ("MonitorDown", "DeployReady", "Action"…). The same reason on the same resource within an hour
    // bumps `count` and `last_at` on the latest row instead of adding one (lib/data/events-write.ts).
    reason: text("reason"),
    count: integer("count").notNull().default(1),
    lastAt: timestamp("last_at", { withTimezone: true }),
  },
  // events_latest (perf P4, 0013): Overview and Events order by the newest occurrence, coalesce(last_at, at), on every
  // refresh; plain ascending, so a backward scan serves ORDER BY … DESC (nulls first) with a LIMIT.
  (t) => [
    index("events_at").on(t.at.desc()), index("events_reason_resource").on(t.reason, t.resourceId, t.at.desc()),
    index("events_latest").on(sql`coalesce(${t.lastAt}, ${t.at})`),
  ],
);

export const collectorRuns = ops.table(
  "collector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    trigger: triggerEnum("trigger").notNull(),
    tasks: jsonb("tasks").$type<string[]>().notNull().default([]),
    ok: boolean("ok"),
    errorSummary: text("error_summary"),
    durationMs: integer("duration_ms"),
    checks: integer("checks").notNull().default(0),
  },
  (t) => [index("collector_runs_started").on(t.startedAt.desc())],
);

// Next.js security check: the version read from the app's live site and the OSV.dev advisories for it. One row per
// watched app (bounded: findings ≤ 50, no page or script bodies). status: ok | vulnerable | unknown | error.
export const appSecurity = ops.table("app_security", {
  resourceId: uuid("resource_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
  framework: text("framework").notNull().default("next"),
  version: text("version"),
  status: text("status").$type<SecurityStatus>().notNull(),
  findings: jsonb("findings").$type<Finding[]>().notNull().default([]),
  reason: text("reason"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});

export const linkKindEnum = ops.enum("link_kind", ["serves", "uses_db"]);
export const linkSourceEnum = ops.enum("link_source", ["auto", "manual"]);

// Topology edges (spec §6, §8.5). Stage 3 writes `uses_db` (app → database: the owner's choice on the app page, at most
// one per app); stage 4 writes `serves` (domain → app, from Vercel's domain list). An edge disappears with either end.
// The console never reads an app's secrets to find its database, so `uses_db` is always the owner's choice.
export const links = ops.table(
  "links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromResourceId: uuid("from_resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    toResourceId: uuid("to_resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    kind: linkKindEnum("kind").notNull(),
    source: linkSourceEnum("source").notNull().default("manual"),
    ...stamps,
  },
  (t) => [
    uniqueIndex("links_from_kind_to").on(t.fromResourceId, t.kind, t.toResourceId),
    uniqueIndex("links_one_db_per_app").on(t.fromResourceId).where(sql`kind = 'uses_db'`),
    index("links_to").on(t.toResourceId),
  ],
);

export const SEVERITIES = ["critical", "warning", "info"] as const;
export const CHANNEL_KINDS = ["telegram", "discord", "webhook", "smtp", "email_digest"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const severityEnum = ops.enum("alert_severity", SEVERITIES);
export const channelKindEnum = ops.enum("channel_kind", CHANNEL_KINDS);

// Spec §10. One row per rule in lib/alerts/catalog.ts, seeded by 0012 and editable by Owners. `threshold` is the one
// number the Edit dialog changes (null for rules without one); `channels` are the push channels plus "email_digest".
export const alertRules = ops.table("alert_rules", {
  key: text("key").primaryKey(),
  severity: severityEnum("severity").notNull(),
  threshold: integer("threshold"),
  enabled: boolean("enabled").notNull().default(true),
  channels: jsonb("channels").$type<ChannelKind[]>().notNull().default([]),
  ...stamps,
});

// One row per firing (or once-fired) alert. `subject` is what the rule watched: a monitor id, an app/db/domain id, an
// account id, or "collector". Exactly one open row per (rule, subject). `pending` is the notification outbox (S3).
export const alerts = ops.table(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleKey: text("rule_key").notNull().references(() => alertRules.key, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    resourceId: uuid("resource_id").references(() => resources.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    severity: severityEnum("severity").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    okStreak: integer("ok_streak").notNull().default(0),
    lastSampleAt: timestamp("last_sample_at", { withTimezone: true }),
    silencedUntil: timestamp("silenced_until", { withTimezone: true }),
    silencedUntilResolved: boolean("silenced_until_resolved").notNull().default(false),
    silencedBy: uuid("silenced_by"),
    causedBy: text("caused_by"),
    providerIncident: text("provider_incident"),
    notifiedOpen: boolean("notified_open").notNull().default(false),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    pending: text("pending").$type<"open" | "repeat" | "resolve">(),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    // The delivery claim: set while one process is sending this notice, so a second one skips it (see deliverPending).
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("alerts_open_rule_subject").on(t.ruleKey, t.subject).where(sql`resolved_at is null`),
    index("alerts_started").on(t.startedAt.desc()),
    index("alerts_pending").on(t.pendingSince).where(sql`pending is not null`),
  ],
);

// Notification channels, one row per kind. The config is encrypted like a credential (lib/crypto): Telegram
// { chatId, chatLabel }, Discord { url }, digest { to }. The bot token and the Resend key are env vars (spec §13).
export const channels = ops.table("channels", {
  kind: channelKindEnum("kind").primaryKey(),
  configCiphertext: text("config_ciphertext").notNull(),
  configIv: text("config_iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...stamps,
});

// Warning/error/fatal runtime-log lines copied from Vercel (S5): scrubbed, ≤ 2,000 characters, 7 days, ≤ 1,000 a day per app.
export const storedLogs = ops.table(
  "stored_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").notNull(),
    rowId: text("row_id").notNull().unique(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    level: text("level").$type<"warning" | "error" | "fatal">().notNull(),
    message: text("message").notNull(),
    requestMethod: text("request_method"),
    requestPath: text("request_path"),
    statusCode: integer("status_code"),
    source: text("source"),
  },
  (t) => [index("stored_logs_resource_at").on(t.resourceId, t.at.desc()), index("stored_logs_at").on(t.at.desc())],
);

// 1.2.3: the affected products/components, the feed's last update, and whether it touches something Watchbell watches
// (all optional: rows written before 1.2.3 lack them).
export type FeedIncident = {
  name: string; impact: string; startedAt: string | null; url: string | null;
  products?: string[]; updatedAt?: string | null; relevant?: boolean;
};

// Latest reading of each provider's public status feed (spec §7.6). One row per feed.
export const providerStatus = ops.table("provider_status", {
  provider: text("provider").primaryKey(),
  state: stateEnum("state").notNull().default("unknown"),
  indicator: text("indicator").notNull().default("unknown"),
  description: text("description").notNull().default(""),
  incidents: jsonb("incidents").$type<FeedIncident[]>().notNull().default([]),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  error: text("error"),
});

// Stage 6 A8: the owner's per-project Keep active (one keep-alive query a day after 5 idle days) and Auto-restore
// (restore a paused project only when its account has a free slot, at most once per 6 h). Supabase only; off by
// default. Console rows: nothing here is sent to a provider.
export const keepActive = ops.table("keep_active", {
  resourceId: uuid("resource_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
  keep: boolean("keep").notNull().default(false),
  autoRestore: boolean("auto_restore").notNull().default(false),
  lastKeepAliveAt: timestamp("last_keep_alive_at", { withTimezone: true }),
  lastAutoRestoreAt: timestamp("last_auto_restore_at", { withTimezone: true }),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Stage 7 (spec §6, §11): one row per backed-up month ("YYYY-MM", WIB). The Drive ids are stored as soon as each file
// exists, so a run that stops half-way is continued by the next daily run instead of creating a second copy.
// status: ok (complete month) | partial ("Back up now" of the month so far) | error (the last attempt failed).
export const BACKUP_STATUSES = ["ok", "partial", "error"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];
export const backups = ops.table("backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  month: text("month").notNull().unique(),
  status: text("status").$type<BackupStatus>().notNull(),
  driveFolderId: text("drive_folder_id"),
  sheetFileId: text("sheet_file_id"),
  csvFileId: text("csv_file_id"),
  sizeBytes: integer("size_bytes"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  ...stamps,
});

// Stage 7, GitHub connection (owner's TODO, 13 Oct): the repositories a read-only fine-grained token can see. Not
// ops.resources rows: repos are never "monitored", and every resource query would have to learn to skip them.
// `actions`: the latest GitHub Actions run on the default branch (only read for repos linked to an app).
export type RepoRun = {
  status: string; conclusion: string | null; name: string | null; branch: string | null; sha: string | null;
  url: string | null; at: string | null; runNumber: number | null;
} | { none: true };
export const githubRepos = ops.table(
  "github_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch"),
    private: boolean("private").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    htmlUrl: text("html_url"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    packageName: text("package_name"),
    packageCheckedAt: timestamp("package_checked_at", { withTimezone: true }),
    actions: jsonb("actions").$type<RepoRun>(),
    actionsCheckedAt: timestamp("actions_checked_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    goneAt: timestamp("gone_at", { withTimezone: true }),
    ...stamps,
  },
  (t) => [uniqueIndex("github_repos_account_external").on(t.accountId, t.externalId), index("github_repos_full_name").on(t.fullName)],
);

// App → repository (at most one per app). `vercel`: from the Vercel project's Git link, written by the GitHub sync;
// `manual`: the owner's choice on the app page (a confirmed suggestion, or another repo), which a sync never overwrites.
export const APP_REPO_SOURCES = ["vercel", "manual"] as const;
export type AppRepoSource = (typeof APP_REPO_SOURCES)[number];
export const appRepos = ops.table(
  "app_repos",
  {
    appId: uuid("app_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").notNull().references(() => githubRepos.id, { onDelete: "cascade" }),
    source: text("source").$type<AppRepoSource>().notNull(),
    linkedBy: uuid("linked_by"),
    ...stamps,
  },
  (t) => [index("app_repos_repo").on(t.repoId)],
);

// Stage 9 slice 5 (owner 16 Oct): the dependency (CVE) scan of the linked repositories' lockfiles (lib/deps/*,
// lib/data/deps-db.ts). One bookkeeping row per scanned repository, and one row per vulnerable package version and
// advisory. A row is resolved (resolved_at) when a later scan no longer finds it; it is never deleted by a scan, only
// with its repository (cascade) or by the daily retention of rows resolved long ago.
export const DEP_SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;
export type DepSeverity = (typeof DEP_SEVERITIES)[number];
export const dependencyScans = ops.table("dependency_scans", {
  repoId: uuid("repo_id").primaryKey().references(() => githubRepos.id, { onDelete: "cascade" }),
  lockfilePath: text("lockfile_path"),
  lockfileSha: text("lockfile_sha"),
  packageCount: integer("package_count").notNull().default(0),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  queriedAt: timestamp("queried_at", { withTimezone: true }),
  error: text("error"),
  note: text("note"),
  ...stamps,
});

export const dependencyVulns = ops.table(
  "dependency_vulns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => githubRepos.id, { onDelete: "cascade" }),
    package: text("package").notNull(),
    installedVersion: text("installed_version").notNull(),
    vulnId: text("vuln_id").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    severity: text("severity").$type<DepSeverity>().notNull(),
    fixedVersion: text("fixed_version"),
    summary: text("summary").notNull().default(""),
    direct: boolean("direct").notNull().default(false),
    dev: boolean("dev").notNull().default(false),
    source: text("source").$type<"osv" | "dependabot">().notNull().default("osv"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("dependency_vulns_open").on(t.repoId, t.package, t.installedVersion, t.vulnId).where(sql`resolved_at is null`),
    index("dependency_vulns_repo").on(t.repoId),
  ],
);

// Automatic security fixes (owner 16 Oct, 0047): one row per update PR Watchbell opened, for the dedupe (never two open
// PRs for one repository and package) and the merge watcher's stages (lib/deps/pr-watch.ts). stage_text is the line the
// app page and the office show (at most 200 chars); smoke_mode says how the preview was tested ("http", or "logs" behind
// Vercel Authentication). Checks, RLS and grants are in the same migration.
export const dependencyPrs = ops.table(
  "dependency_prs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => githubRepos.id, { onDelete: "cascade" }),
    appId: uuid("app_id").references(() => resources.id, { onDelete: "set null" }),
    proposalId: uuid("proposal_id"),
    number: integer("number").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    headSha: text("head_sha").notNull(),
    title: text("title").notNull(),
    packages: jsonb("packages").$type<string[]>().notNull().default([]),
    auto: boolean("auto").notNull().default(false),
    stage: text("stage").$type<PrStage>().notNull().default("checks"),
    stageText: text("stage_text"),
    smokeMode: text("smoke_mode").$type<"http" | "logs">(),
    previewReadyAt: timestamp("preview_ready_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    mergedSha: text("merged_sha"),
  },
  (t) => [uniqueIndex("dependency_prs_repo_number").on(t.repoId, t.number), index("dependency_prs_stage").on(t.stage)],
);

// Self-host local sign-in (WATCHBELL_MODE=selfhost). Unused in cloud, where Supabase Auth owns identities. RLS, grants
// and value checks are in drizzle/0054_local_auth.sql (self-host: drizzle-selfhost/0003_local_auth.sql, no roles).
// `passwordHash` is `scrypt$N$r$p$saltB64$hashB64`; `totpSecretSealed` is the TOTP secret sealed with OPS_ENCRYPTION_KEY;
// `totpLastStep` is the last accepted 30 s step, so a code can't be replayed within its window. `tempPasswordExpiresAt`
// is set while the password is a temporary one (added by an owner, or `npm run reset-login`): it stops working then.
export const localUsers = ops.table(
  "local_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    totpSecretSealed: text("totp_secret_sealed"),
    totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    tempPasswordExpiresAt: timestamp("temp_password_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("local_users_email").on(t.email)],
);

// One row per browser session. The cookie holds the random token; only its sha256 hex is stored. `aal` is "aal1" until
// the session's TOTP is verified, then "aal2".
export const localSessions = ops.table(
  "local_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => localUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    aal: text("aal").$type<"aal1" | "aal2">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [uniqueIndex("local_sessions_token_hash").on(t.tokenHash), index("local_sessions_user").on(t.userId)],
);
