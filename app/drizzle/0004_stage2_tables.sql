CREATE TYPE "ops"."event_type" AS ENUM('deployment', 'monitor', 'database', 'system', 'action');--> statement-breakpoint
CREATE TYPE "ops"."resource_kind" AS ENUM('app', 'supabase_project', 'neon_project', 'neon_branch', 'firestore', 'zone', 'domain', 'dns_record');--> statement-breakpoint
CREATE TYPE "ops"."state" AS ENUM('ok', 'warn', 'err', 'idle', 'build', 'paused', 'info', 'fail', 'off', 'unknown');--> statement-breakpoint
CREATE TYPE "ops"."collector_trigger" AS ENUM('cron_job_org', 'qstash', 'vercel_cron', 'manual');--> statement-breakpoint
CREATE TABLE "ops"."checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"error" text
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
	"actor_user_id" uuid
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
	"state" "ops"."state" DEFAULT 'unknown' NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status" integer,
	"last_latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	CONSTRAINT "rollups_hourly_monitor_id_hour_pk" PRIMARY KEY("monitor_id","hour")
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
ALTER TABLE "ops"."accounts" ADD COLUMN "watch_new" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."checks" ADD CONSTRAINT "checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."deployments" ADD CONSTRAINT "deployments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."events" ADD CONSTRAINT "events_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD CONSTRAINT "monitors_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."resources" ADD CONSTRAINT "resources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."rollups_hourly" ADD CONSTRAINT "rollups_hourly_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."snapshots" ADD CONSTRAINT "snapshots_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checks_monitor_at" ON "ops"."checks" USING btree ("monitor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collector_runs_started" ON "ops"."collector_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployments_resource_created" ON "ops"."deployments" USING btree ("resource_id","created_at_provider" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_at" ON "ops"."events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_resource_url" ON "ops"."monitors" USING btree ("resource_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_account_kind_external" ON "ops"."resources" USING btree ("account_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "resources_account_kind" ON "ops"."resources" USING btree ("account_id","kind");