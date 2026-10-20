CREATE TYPE "ops"."link_kind" AS ENUM('serves', 'uses_db');--> statement-breakpoint
CREATE TYPE "ops"."link_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TABLE "ops"."links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_resource_id" uuid NOT NULL,
	"to_resource_id" uuid NOT NULL,
	"kind" "ops"."link_kind" NOT NULL,
	"source" "ops"."link_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."links" ADD CONSTRAINT "links_from_resource_id_resources_id_fk" FOREIGN KEY ("from_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."links" ADD CONSTRAINT "links_to_resource_id_resources_id_fk" FOREIGN KEY ("to_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "links_from_kind_to" ON "ops"."links" USING btree ("from_resource_id","kind","to_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_one_db_per_app" ON "ops"."links" USING btree ("from_resource_id") WHERE kind = 'uses_db';--> statement-breakpoint
CREATE INDEX "links_to" ON "ops"."links" USING btree ("to_resource_id");
--> statement-breakpoint
-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.links enable row level security;--> statement-breakpoint
revoke all on ops.links from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.links to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.links for all to ops_app using (true) with check (true);
