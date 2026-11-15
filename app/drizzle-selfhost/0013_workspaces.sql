CREATE TABLE "ops"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Watchbell 1.8: the upgrade makes one workspace, "Personal", the default; new rows (and, by the column default, every
-- existing row as the columns are added) land in the default workspace through ops.default_workspace_id().
INSERT INTO "ops"."workspaces" ("id", "name", "position") VALUES ('00000000-0000-4000-8000-00000000f001', 'Personal', 0);--> statement-breakpoint
INSERT INTO "ops"."settings" ("key", "value") SELECT 'workspace.default', to_jsonb("id"::text) FROM "ops"."workspaces" ORDER BY "position" LIMIT 1 ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops.default_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  select coalesce(
    (select w.id from ops.workspaces w where w.id::text = (select s.value #>> '{}' from ops.settings s where s.key = 'workspace.default')),
    (select w.id from ops.workspaces w order by w.position, w.name limit 1))
$$;--> statement-breakpoint
ALTER TABLE "ops"."github_repos" ADD COLUMN "workspace_id" uuid DEFAULT ops.default_workspace_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "ops"."resources" ADD COLUMN "workspace_id" uuid DEFAULT ops.default_workspace_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."resources" ADD COLUMN "sorted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops"."status_pages" ADD COLUMN "workspace_id" uuid DEFAULT ops.default_workspace_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."reports" ADD COLUMN "workspace_id" uuid DEFAULT ops.default_workspace_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."github_repos" ADD CONSTRAINT "github_repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "ops"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD CONSTRAINT "maintenance_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "ops"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."resources" ADD CONSTRAINT "resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "ops"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."status_pages" ADD CONSTRAINT "status_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "ops"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "ops"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resources_workspace" ON "ops"."resources" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "ops"."status_pages" ADD CONSTRAINT "status_pages_workspace_id_unique" UNIQUE("workspace_id");--> statement-breakpoint
alter table ops.workspaces add constraint workspaces_values_check check (char_length(name) between 1 and 60 and name = btrim(name) and position >= 0);--> statement-breakpoint
create unique index workspaces_name_lower on ops.workspaces (lower(name));--> statement-breakpoint
alter table ops.maintenance_windows drop constraint maintenance_windows_scope_check;--> statement-breakpoint
alter table ops.maintenance_windows add constraint maintenance_windows_scope_check check (scope in ('all', 'app', 'monitor', 'workspace') and ((scope = 'workspace') = (workspace_id is not null)));
