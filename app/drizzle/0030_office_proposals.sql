-- Stage 9 slice 1 (owner 15 Oct): ops agents propose, the owner approves. One row per proposal to run an existing
-- console action for a firing alert (src/private/office/proposals-types.ts). Additive: one new table. RLS, grants and
-- value checks are in 0031.
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
CREATE UNIQUE INDEX "action_proposals_open_alert_action" ON "ops"."action_proposals" USING btree ("alert_id","action") WHERE status in ('pending', 'approved', 'running');--> statement-breakpoint
CREATE INDEX "action_proposals_status_created_idx" ON "ops"."action_proposals" USING btree ("status","created_at");