-- Stage 9 slice 4 (owner 16 Oct): the runner on the owner's VM. Additive: three new tables. ops.runners (the runner's
-- token, sha256 only, plus last seen / version / host), ops.runner_repo_settings (per repository: install scripts off by
-- default, the app's port, non-secret env added by hand later) and ops.runner_jobs (preview and lockfile jobs, leases,
-- the one-time archive token hash). RLS, grants and value checks are in 0052.
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
ALTER TABLE "ops"."runner_jobs" ADD CONSTRAINT "runner_jobs_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."runner_jobs" ADD CONSTRAINT "runner_jobs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "ops"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."runner_repo_settings" ADD CONSTRAINT "runner_repo_settings_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_jobs_status" ON "ops"."runner_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runner_jobs_repo" ON "ops"."runner_jobs" USING btree ("repo_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_jobs_archive_token" ON "ops"."runner_jobs" USING btree ("archive_token_hash") WHERE archive_token_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_token_hash" ON "ops"."runners" USING btree ("token_hash");
