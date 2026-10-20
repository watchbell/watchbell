-- Stage 7, GitHub connection (owner 13 Oct): a new provider value, the repositories a read-only token can see, and
-- the app → repository links. Additive. The new enum value is not used in this file (Postgres allows ADD VALUE inside a
-- transaction only when nothing in it uses the value).
ALTER TYPE "ops"."provider" ADD VALUE 'github';--> statement-breakpoint
CREATE TABLE "ops"."app_repos" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"source" text NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"private" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"html_url" text,
	"pushed_at" timestamp with time zone,
	"package_name" text,
	"package_checked_at" timestamp with time zone,
	"actions" jsonb,
	"actions_checked_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."app_repos" ADD CONSTRAINT "app_repos_app_id_resources_id_fk" FOREIGN KEY ("app_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."app_repos" ADD CONSTRAINT "app_repos_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."github_repos" ADD CONSTRAINT "github_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_repos_repo" ON "ops"."app_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repos_account_external" ON "ops"."github_repos" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "github_repos_full_name" ON "ops"."github_repos" USING btree ("full_name");