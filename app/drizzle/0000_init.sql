CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "ops"."account_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TYPE "ops"."provider" AS ENUM('vercel', 'supabase', 'neon', 'firebase', 'cloudflare', 'drive');--> statement-breakpoint
CREATE TYPE "ops"."role" AS ENUM('owner', 'operator', 'viewer');--> statement-breakpoint
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
CREATE TABLE "ops"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_label" ON "ops"."accounts" USING btree ("provider","label");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_open_email" ON "ops"."invites" USING btree ("email") WHERE accepted_at is null;