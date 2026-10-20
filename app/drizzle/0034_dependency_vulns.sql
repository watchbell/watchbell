-- Stage 9 slice 5 (owner 16 Oct): the dependency (CVE) scan of the linked repositories, and the GitHub PR-write
-- credential slot. Additive: one provider value (not used in this file; Postgres allows ADD VALUE in a transaction only
-- when nothing in it uses the value), two tables, and the office proposals' action check widened by one value
-- ('github_bump_pr'). RLS, grants, value checks and the VulnerableDependency rule's seed row are in 0035.
ALTER TYPE "ops"."provider" ADD VALUE 'github_write';--> statement-breakpoint
CREATE TABLE "ops"."dependency_scans" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"lockfile_path" text,
	"lockfile_sha" text,
	"package_count" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"queried_at" timestamp with time zone,
	"error" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."dependency_vulns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"package" text NOT NULL,
	"installed_version" text NOT NULL,
	"vuln_id" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity" text NOT NULL,
	"fixed_version" text,
	"summary" text DEFAULT '' NOT NULL,
	"direct" boolean DEFAULT false NOT NULL,
	"dev" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'osv' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ops"."dependency_scans" ADD CONSTRAINT "dependency_scans_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dependency_vulns" ADD CONSTRAINT "dependency_vulns_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_vulns_open" ON "ops"."dependency_vulns" USING btree ("repo_id","package","installed_version","vuln_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "dependency_vulns_repo" ON "ops"."dependency_vulns" USING btree ("repo_id");--> statement-breakpoint
-- The proposals' action list gains 'github_bump_pr' (src/private/office/proposals-types.ts). Drop and recreate: a check
-- can't be altered in place. Every existing row keeps a value the new check allows.
alter table ops.action_proposals drop constraint if exists action_proposals_action_check;--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_action_check check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback', 'github_bump_pr'));
