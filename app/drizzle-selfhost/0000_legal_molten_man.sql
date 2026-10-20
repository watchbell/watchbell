CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "ops"."account_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TYPE "ops"."channel_kind" AS ENUM('telegram', 'discord', 'email_digest');--> statement-breakpoint
CREATE TYPE "ops"."event_type" AS ENUM('deployment', 'monitor', 'database', 'system', 'action');--> statement-breakpoint
CREATE TYPE "ops"."link_kind" AS ENUM('serves', 'uses_db');--> statement-breakpoint
CREATE TYPE "ops"."link_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "ops"."provider" AS ENUM('vercel', 'supabase', 'neon', 'firebase', 'cloudflare', 'drive', 'github', 'github_write', 'turso', 'upstash');--> statement-breakpoint
CREATE TYPE "ops"."resource_kind" AS ENUM('app', 'supabase_project', 'neon_project', 'neon_branch', 'firestore', 'zone', 'domain', 'dns_record', 'turso_database', 'upstash_redis', 'd1_database');--> statement-breakpoint
CREATE TYPE "ops"."role" AS ENUM('owner', 'operator', 'viewer');--> statement-breakpoint
CREATE TYPE "ops"."alert_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "ops"."state" AS ENUM('ok', 'warn', 'err', 'idle', 'build', 'paused', 'info', 'fail', 'off', 'unknown', 'maint');--> statement-breakpoint
CREATE TYPE "ops"."collector_trigger" AS ENUM('cron_job_org', 'qstash', 'vercel_cron', 'manual');--> statement-breakpoint
CREATE TABLE "ops"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "ops"."provider" NOT NULL,
	"label" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"credential_kind" text NOT NULL,
	"scope_note" text,
	"expires_at" timestamp with time zone,
	"status" "ops"."account_status" DEFAULT 'ok' NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"watch_new" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."alert_rules" (
	"key" text PRIMARY KEY NOT NULL,
	"severity" "ops"."alert_severity" NOT NULL,
	"threshold" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" text NOT NULL,
	"subject" text NOT NULL,
	"resource_id" uuid,
	"account_id" uuid,
	"severity" "ops"."alert_severity" NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"ok_streak" integer DEFAULT 0 NOT NULL,
	"last_sample_at" timestamp with time zone,
	"silenced_until" timestamp with time zone,
	"silenced_until_resolved" boolean DEFAULT false NOT NULL,
	"silenced_by" uuid,
	"caused_by" text,
	"provider_incident" text,
	"notified_open" boolean DEFAULT false NOT NULL,
	"last_notified_at" timestamp with time zone,
	"pending" text,
	"pending_since" timestamp with time zone,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."app_repos" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"source" text NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."app_security" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"framework" text DEFAULT 'next' NOT NULL,
	"version" text,
	"status" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" text NOT NULL,
	"status" text NOT NULL,
	"drive_folder_id" text,
	"sheet_file_id" text,
	"csv_file_id" text,
	"size_bytes" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backups_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "ops"."channels" (
	"kind" "ops"."channel_kind" PRIMARY KEY NOT NULL,
	"config_ciphertext" text NOT NULL,
	"config_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"error" text,
	"in_maintenance" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"trigger" "ops"."collector_trigger" NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ok" boolean,
	"error_summary" text,
	"duration_ms" integer,
	"checks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."dependency_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"app_id" uuid,
	"proposal_id" uuid,
	"number" integer NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"title" text NOT NULL,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"stage" text DEFAULT 'checks' NOT NULL,
	"stage_text" text,
	"smoke_mode" text,
	"preview_ready_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"merged_sha" text
);
--> statement-breakpoint
CREATE TABLE "ops"."dependency_scans" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"lockfile_path" text,
	"lockfile_sha" text,
	"package_count" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"queried_at" timestamp with time zone,
	"error" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."dependency_vulns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"package" text NOT NULL,
	"installed_version" text NOT NULL,
	"vuln_id" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity" text NOT NULL,
	"fixed_version" text,
	"summary" text DEFAULT '' NOT NULL,
	"direct" boolean DEFAULT false NOT NULL,
	"dev" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'osv' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"state" text NOT NULL,
	"target" text,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"source" text,
	"url" text,
	"building_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"created_at_provider" timestamp with time zone NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"is_previous_production" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"resource_id" uuid,
	"type" "ops"."event_type" NOT NULL,
	"kind" "ops"."state" NOT NULL,
	"message" text NOT NULL,
	"detail" text,
	"actor_user_id" uuid,
	"reason" text,
	"count" integer DEFAULT 1 NOT NULL,
	"last_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"private" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"html_url" text,
	"pushed_at" timestamp with time zone,
	"package_name" text,
	"package_checked_at" timestamp with time zone,
	"actions" jsonb,
	"actions_checked_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "ops"."role" NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."keep_active" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"keep" boolean DEFAULT false NOT NULL,
	"auto_restore" boolean DEFAULT false NOT NULL,
	"last_keep_alive_at" timestamp with time zone,
	"last_auto_restore_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_resource_id" uuid NOT NULL,
	"to_resource_id" uuid NOT NULL,
	"kind" "ops"."link_kind" NOT NULL,
	"source" "ops"."link_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"resource_id" uuid,
	"monitor_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"weekly" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "ops"."role" NOT NULL,
	"invited_by" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ops"."monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"url" text NOT NULL,
	"expected_status" integer DEFAULT 200 NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"interval_s" integer DEFAULT 60 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"owner_paused" boolean DEFAULT false NOT NULL,
	"state" "ops"."state" DEFAULT 'unknown' NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status" integer,
	"last_latency_ms" integer,
	"kind" text DEFAULT 'http' NOT NULL,
	"name" text,
	"body_contains" text,
	"json_path" text,
	"json_equals" text,
	"last_error" text,
	"token_hash" text,
	"period_s" integer,
	"grace_s" integer,
	"last_ping_at" timestamp with time zone,
	"last_ping_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."provider_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"state" "ops"."state" DEFAULT 'unknown' NOT NULL,
	"indicator" text DEFAULT 'unknown' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"incidents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "ops"."rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "ops"."recommendation_dismissals" (
	"key" text PRIMARY KEY NOT NULL,
	"dismissed_at" timestamp with time zone NOT NULL,
	"dismissed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ops"."resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "ops"."resource_kind" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"monitored" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."rollups_hourly" (
	"monitor_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"checks" integer NOT NULL,
	"failures" integer NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	"max_ms" integer,
	"status_5xx" integer DEFAULT 0 NOT NULL,
	"maintenance" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rollups_hourly_monitor_id_hour_pk" PRIMARY KEY("monitor_id","hour")
);
--> statement-breakpoint
CREATE TABLE "ops"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."snapshots" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"state" "ops"."state" DEFAULT 'unknown' NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."status_page_monitors" (
	"page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"badge_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_page_monitors_page_id_monitor_id_pk" PRIMARY KEY("page_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"announcement" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ops"."stored_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"row_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"request_method" text,
	"request_path" text,
	"status_code" integer,
	"source" text,
	CONSTRAINT "stored_logs_row_id_unique" UNIQUE("row_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."supabase_metrics" (
	"resource_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"cpu_samples" integer DEFAULT 0 NOT NULL,
	"cpu_avg" real,
	"cpu_max" real,
	"mem_avg" real,
	"mem_max" real,
	"disk_pct" real,
	"conn_used" integer,
	"conn_max" integer,
	CONSTRAINT "supabase_metrics_resource_id_hour_pk" PRIMARY KEY("resource_id","hour")
);
--> statement-breakpoint
CREATE TABLE "ops"."supabase_metrics_keys" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"added_by" uuid,
	"latest" jsonb,
	"last_try_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."sql_connections" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"dsn_ciphertext" text NOT NULL,
	"dsn_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"role_name" text NOT NULL,
	"endpoint_id" text,
	"added_by" uuid,
	"verified_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."create_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" uuid,
	"target_resource_id" uuid,
	"target_label" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."runner_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"repo_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"runner_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"port" integer,
	"url" text,
	"logs" text,
	"error" text,
	"archive_token_hash" text,
	"archive_expires_at" timestamp with time zone,
	"archive_used_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."runner_repo_settings" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"install_scripts" boolean DEFAULT false NOT NULL,
	"app_port" integer DEFAULT 3000 NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"version" text,
	"host" text
);
--> statement-breakpoint
CREATE TABLE "ops"."action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid,
	"rule_key" text NOT NULL,
	"room" text NOT NULL,
	"action" text NOT NULL,
	"risk" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"resource_kind" text,
	"resource_id" uuid,
	"resource_name" text,
	"target_ref" text,
	"proposed_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"result" text,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid,
	"client_name" text NOT NULL,
	"client_version" text DEFAULT '' NOT NULL,
	"via" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"display_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"recent" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid,
	"source" text NOT NULL,
	"app_id" text,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"model" text,
	"client" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"key_hint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_kind" text NOT NULL,
	"context_id" uuid,
	"question" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"answered_by_client" text,
	"answered_by_model" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"requested_model" text,
	"purpose" text DEFAULT 'ask' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_quota" (
	"provider_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"metric" text NOT NULL,
	"window_start" timestamp with time zone,
	"used" integer,
	"limit" integer,
	"remaining" integer,
	"reset_at" timestamp with time zone,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_quota_provider_id_scope_metric_pk" PRIMARY KEY("provider_id","scope","metric")
);
--> statement-breakpoint
CREATE TABLE "ops"."ai_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_id" uuid,
	"agent_id" uuid,
	"provider_id" uuid,
	"model" text,
	"kind" text NOT NULL,
	"tool" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer NOT NULL,
	"status" integer NOT NULL,
	"error_class" text,
	"stream" boolean DEFAULT false NOT NULL,
	"tokens_cached" integer,
	"tokens_thinking" integer
);
--> statement-breakpoint
CREATE TABLE "ops"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"rate_per_min" integer DEFAULT 20 NOT NULL,
	"provider_id" uuid,
	"model" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."dev_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"proposal_id" uuid,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"repo" text,
	"ref" text,
	"question" text NOT NULL,
	"summary" text,
	"cause" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"patch" text,
	"confidence" text,
	"model" text,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"source" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."office_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"session" text NOT NULL,
	"project" text,
	"agent" text,
	"agent_type" text,
	"ev" text NOT NULL,
	"tool" text,
	"summary" text,
	"kind" text,
	"spawn" jsonb,
	"usage" jsonb,
	"key_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ops"."office_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"rooms" jsonb,
	"model" text,
	"via" text,
	"usage" jsonb,
	"key_id" uuid,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_rule_key_alert_rules_key_fk" FOREIGN KEY ("rule_key") REFERENCES "ops"."alert_rules"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."app_repos" ADD CONSTRAINT "app_repos_app_id_resources_id_fk" FOREIGN KEY ("app_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."app_repos" ADD CONSTRAINT "app_repos_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."app_security" ADD CONSTRAINT "app_security_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."checks" ADD CONSTRAINT "checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_prs" ADD CONSTRAINT "dependency_prs_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_prs" ADD CONSTRAINT "dependency_prs_app_id_resources_id_fk" FOREIGN KEY ("app_id") REFERENCES "ops"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_scans" ADD CONSTRAINT "dependency_scans_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_vulns" ADD CONSTRAINT "dependency_vulns_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."deployments" ADD CONSTRAINT "deployments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."events" ADD CONSTRAINT "events_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."github_repos" ADD CONSTRAINT "github_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."keep_active" ADD CONSTRAINT "keep_active_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."links" ADD CONSTRAINT "links_from_resource_id_resources_id_fk" FOREIGN KEY ("from_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."links" ADD CONSTRAINT "links_to_resource_id_resources_id_fk" FOREIGN KEY ("to_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD CONSTRAINT "maintenance_windows_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD CONSTRAINT "maintenance_windows_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD CONSTRAINT "monitors_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."resources" ADD CONSTRAINT "resources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."rollups_hourly" ADD CONSTRAINT "rollups_hourly_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."snapshots" ADD CONSTRAINT "snapshots_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."status_page_monitors" ADD CONSTRAINT "status_page_monitors_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "ops"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stored_logs" ADD CONSTRAINT "stored_logs_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD CONSTRAINT "supabase_metrics_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics_keys" ADD CONSTRAINT "supabase_metrics_keys_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sql_connections" ADD CONSTRAINT "sql_connections_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."runner_jobs" ADD CONSTRAINT "runner_jobs_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."runner_jobs" ADD CONSTRAINT "runner_jobs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "ops"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."runner_repo_settings" ADD CONSTRAINT "runner_repo_settings_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."ai_agents" ADD CONSTRAINT "ai_agents_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "ops"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."ai_notes" ADD CONSTRAINT "ai_notes_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "ops"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."ai_quota" ADD CONSTRAINT "ai_quota_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."api_keys" ADD CONSTRAINT "api_keys_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_label" ON "ops"."accounts" USING btree ("provider","label");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_rule_subject" ON "ops"."alerts" USING btree ("rule_key","subject") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "alerts_started" ON "ops"."alerts" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alerts_pending" ON "ops"."alerts" USING btree ("pending_since") WHERE pending is not null;--> statement-breakpoint
CREATE INDEX "app_repos_repo" ON "ops"."app_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "checks_monitor_at" ON "ops"."checks" USING btree ("monitor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checks_at" ON "ops"."checks" USING btree ("at");--> statement-breakpoint
CREATE INDEX "collector_runs_started" ON "ops"."collector_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_prs_repo_number" ON "ops"."dependency_prs" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "dependency_prs_stage" ON "ops"."dependency_prs" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_vulns_open" ON "ops"."dependency_vulns" USING btree ("repo_id","package","installed_version","vuln_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "dependency_vulns_repo" ON "ops"."dependency_vulns" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "deployments_resource_created" ON "ops"."deployments" USING btree ("resource_id","created_at_provider" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployments_created" ON "ops"."deployments" USING btree ("created_at_provider");--> statement-breakpoint
CREATE INDEX "events_at" ON "ops"."events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_reason_resource" ON "ops"."events" USING btree ("reason","resource_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_latest" ON "ops"."events" USING btree (coalesce("last_at", "at"));--> statement-breakpoint
CREATE UNIQUE INDEX "github_repos_account_external" ON "ops"."github_repos" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "github_repos_full_name" ON "ops"."github_repos" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_open_email" ON "ops"."invites" USING btree ("email") WHERE accepted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "links_from_kind_to" ON "ops"."links" USING btree ("from_resource_id","kind","to_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_one_db_per_app" ON "ops"."links" USING btree ("from_resource_id") WHERE kind = 'uses_db';--> statement-breakpoint
CREATE INDEX "links_to" ON "ops"."links" USING btree ("to_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_resource_url" ON "ops"."monitors" USING btree ("resource_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_token_hash" ON "ops"."monitors" USING btree ("token_hash") WHERE token_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_account_kind_external" ON "ops"."resources" USING btree ("account_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "resources_account_kind" ON "ops"."resources" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_monitors_badge" ON "ops"."status_page_monitors" USING btree ("page_id","badge_key");--> statement-breakpoint
CREATE INDEX "stored_logs_resource_at" ON "ops"."stored_logs" USING btree ("resource_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stored_logs_at" ON "ops"."stored_logs" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supabase_metrics_hour_idx" ON "ops"."supabase_metrics" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "create_requests_status_created_idx" ON "ops"."create_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "create_requests_requested_by_created_idx" ON "ops"."create_requests" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "runner_jobs_status" ON "ops"."runner_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runner_jobs_repo" ON "ops"."runner_jobs" USING btree ("repo_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_jobs_archive_token" ON "ops"."runner_jobs" USING btree ("archive_token_hash") WHERE archive_token_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_token_hash" ON "ops"."runners" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_open_alert_action" ON "ops"."action_proposals" USING btree ("alert_id","action") WHERE status in ('pending', 'approved', 'running');--> statement-breakpoint
CREATE INDEX "action_proposals_status_created_idx" ON "ops"."action_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_notes_created_idx" ON "ops"."ai_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_questions_status_created_idx" ON "ops"."ai_questions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ops"."ai_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ai_usage_key_at_idx" ON "ops"."ai_usage" USING btree ("key_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "ops"."api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dev_notes_proposal_one" ON "ops"."dev_notes" USING btree ("proposal_id") WHERE proposal_id is not null;--> statement-breakpoint
CREATE INDEX "dev_notes_created_idx" ON "ops"."dev_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dev_notes_app_status_idx" ON "ops"."dev_notes" USING btree ("app_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_url_day" ON "ops"."news_items" USING btree ("url","day");--> statement-breakpoint
CREATE INDEX "news_items_day_topic_idx" ON "ops"."news_items" USING btree ("day","topic");--> statement-breakpoint
CREATE INDEX "office_events_at_idx" ON "ops"."office_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "office_reports_at_idx" ON "ops"."office_reports" USING btree ("at");