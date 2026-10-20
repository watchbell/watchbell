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
	"answered_at" timestamp with time zone
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
	"stream" boolean DEFAULT false NOT NULL
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
ALTER TABLE "ops"."ai_agents" ADD CONSTRAINT "ai_agents_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "ops"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."ai_notes" ADD CONSTRAINT "ai_notes_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "ops"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."ai_quota" ADD CONSTRAINT "ai_quota_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."api_keys" ADD CONSTRAINT "api_keys_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_notes_created_idx" ON "ops"."ai_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_questions_status_created_idx" ON "ops"."ai_questions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ops"."ai_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ai_usage_key_at_idx" ON "ops"."ai_usage" USING btree ("key_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "ops"."api_keys" USING btree ("key_hash");