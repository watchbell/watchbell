import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { githubRepos, ops } from "./schema";

// Stage 9 slice 4 (owner 16 Oct): the runner on the owner's VM (runner/ at the repository root). drizzle.config.ts reads
// this file too; RLS, grants and value checks are in drizzle/0052_runner_lockdown.sql. Separate from schema.ts so
// parallel stages don't edit the same file.

// The runner itself: one active row at a time (0052's partial unique index). Its token is shown once to the owner and
// stored as sha256 hex plus the first 7 characters (`wr_7Hq2`), like the console API keys. `host` is the name the VM
// reports (the preview links are http://<host>:<port>, inside the owner's tailnet).
export const runners = ops.table(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    version: text("version"),
    host: text("host"),
  },
  (t) => [uniqueIndex("runners_token_hash").on(t.tokenHash)],
);

// Per repository: how a preview installs and listens. `install_scripts` false (default) means `npm ci --ignore-scripts`.
// `env`: non-secret variables the owner adds by hand later; Watchbell never copies an app's real env values here.
export const runnerRepoSettings = ops.table("runner_repo_settings", {
  repoId: uuid("repo_id").primaryKey().references(() => githubRepos.id, { onDelete: "cascade" }),
  installScripts: boolean("install_scripts").notNull().default(false),
  appPort: integer("app_port").notNull().default(3000),
  env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const RUNNER_JOB_KINDS = ["preview", "lockfile"] as const;
export type RunnerJobKind = (typeof RUNNER_JOB_KINDS)[number];
export const RUNNER_JOB_STATUSES = ["queued", "claimed", "running", "ready", "stopping", "stopped", "succeeded", "failed"] as const;
export type RunnerJobStatus = (typeof RUNNER_JOB_STATUSES)[number];

// One job for the runner. A claim leases it (lease_until); a lapsed lease is requeued or ended (the runner's jobs.ts
// expiryStep). The archive token (sha256 only) lets the runner fetch the repository archive once, within 10 minutes.
export const runnerJobs = ops.table(
  "runner_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<RunnerJobKind>().notNull(),
    status: text("status").$type<RunnerJobStatus>().notNull().default("queued"),
    repoId: uuid("repo_id").notNull().references(() => githubRepos.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(),
    sha: text("sha").notNull(),
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    port: integer("port"),
    url: text("url"),
    logs: text("logs"),
    error: text("error"),
    archiveTokenHash: text("archive_token_hash"),
    archiveExpiresAt: timestamp("archive_expires_at", { withTimezone: true }),
    archiveUsedAt: timestamp("archive_used_at", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("runner_jobs_status").on(t.status, t.createdAt),
    index("runner_jobs_repo").on(t.repoId, t.kind, t.createdAt),
    uniqueIndex("runner_jobs_archive_token").on(t.archiveTokenHash).where(sql`archive_token_hash is not null`),
  ],
);
