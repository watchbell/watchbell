-- Automatic security fixes (owner 16 Oct: "Auto aja, soalnya tentang keamanan dependencies"). Additive: one new table,
-- ops.dependency_prs (Watchpost's own update PRs and the merge watcher's stage), and the office auto-run check widened so
-- an approved-by-setting github_bump_pr may run without asking (like vercel_rollback since 0046).
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
ALTER TABLE "ops"."dependency_prs" ADD CONSTRAINT "dependency_prs_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_prs" ADD CONSTRAINT "dependency_prs_app_id_resources_id_fk" FOREIGN KEY ("app_id") REFERENCES "ops"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_prs_repo_number" ON "ops"."dependency_prs" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "dependency_prs_stage" ON "ops"."dependency_prs" USING btree ("stage");
--> statement-breakpoint
-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.dependency_prs enable row level security;--> statement-breakpoint
revoke all on ops.dependency_prs from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.dependency_prs to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.dependency_prs for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them).
alter table ops.dependency_prs add constraint dependency_prs_stage_check check (stage in ('checks', 'preview', 'smoke', 'merging', 'merged', 'ready-manual', 'failed', 'timeout', 'closed'));--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_smoke_mode_check check (smoke_mode is null or smoke_mode in ('http', 'logs'));--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_branch_check check (branch ~ '^watchpost/deps-[0-9a-f]{8}$');--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_head_sha_check check (head_sha ~ '^[0-9a-f]{40}$');--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_number_check check (number > 0);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_stage_text_check check (stage_text is null or char_length(stage_text) <= 200);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_packages_check check (jsonb_typeof(packages) = 'array' and octet_length(packages::text) <= 4096);--> statement-breakpoint
-- The office auto-run: a risky kind may run without asking only for vercel_rollback (0046) and github_bump_pr (this).
alter table ops.action_proposals drop constraint if exists action_proposals_auto_check;--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_auto_check check (not auto or risk = 'safe' or action in ('vercel_rollback', 'github_bump_pr'));
