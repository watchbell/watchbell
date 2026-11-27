CREATE TABLE "ops"."ingest_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT 'Alertmanager' NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"month_key" text,
	"received_month" integer DEFAULT 0 NOT NULL,
	"refused_month" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingest_sources_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD COLUMN "labels" jsonb;