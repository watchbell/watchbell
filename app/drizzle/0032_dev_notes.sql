-- Stage 9 slice 3 (owner 16 Oct): the Dev officer's notes (src/private/office/dev-notes-types.ts). Additive: one new table.
-- RLS, grants, value checks and the one-open-note-per-app index are in 0033.
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
CREATE UNIQUE INDEX "dev_notes_proposal_one" ON "ops"."dev_notes" USING btree ("proposal_id") WHERE proposal_id is not null;--> statement-breakpoint
CREATE INDEX "dev_notes_created_idx" ON "ops"."dev_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dev_notes_app_status_idx" ON "ops"."dev_notes" USING btree ("app_id","status");