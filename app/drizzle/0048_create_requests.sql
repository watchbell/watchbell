-- Stage 6 create requests (owner 16 Oct; spec 2026-10-15-stage-6-create-resources.md): one row per request to create a
-- resource (Cloudflare DNS record, Neon branch, Supabase project, Firebase project), approved by the Owner with aal2.
-- Additive: one new table. RLS, grants and value checks are in 0049. Inputs never hold a secret.
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
CREATE INDEX "create_requests_status_created_idx" ON "ops"."create_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "create_requests_requested_by_created_idx" ON "ops"."create_requests" USING btree ("requested_by","created_at");