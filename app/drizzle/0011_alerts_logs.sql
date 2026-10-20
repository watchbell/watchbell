CREATE TYPE "ops"."channel_kind" AS ENUM('telegram', 'discord', 'email_digest');--> statement-breakpoint
CREATE TYPE "ops"."alert_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
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
ALTER TABLE "ops"."events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "ops"."events" ADD COLUMN "count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."events" ADD COLUMN "last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_rule_key_alert_rules_key_fk" FOREIGN KEY ("rule_key") REFERENCES "ops"."alert_rules"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stored_logs" ADD CONSTRAINT "stored_logs_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_rule_subject" ON "ops"."alerts" USING btree ("rule_key","subject") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "alerts_started" ON "ops"."alerts" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alerts_pending" ON "ops"."alerts" USING btree ("pending_since") WHERE pending is not null;--> statement-breakpoint
CREATE INDEX "stored_logs_resource_at" ON "ops"."stored_logs" USING btree ("resource_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stored_logs_at" ON "ops"."stored_logs" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_reason_resource" ON "ops"."events" USING btree ("reason","resource_id","at" DESC NULLS LAST);