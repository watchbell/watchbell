ALTER TYPE "ops"."state" ADD VALUE 'maint';--> statement-breakpoint
CREATE TABLE "ops"."maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"resource_id" uuid,
	"monitor_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"weekly" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."recommendation_dismissals" (
	"key" text PRIMARY KEY NOT NULL,
	"dismissed_at" timestamp with time zone NOT NULL,
	"dismissed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ops"."status_page_monitors" (
	"page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"badge_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_page_monitors_page_id_monitor_id_pk" PRIMARY KEY("page_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"announcement" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "ops"."checks" ADD COLUMN "in_maintenance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "kind" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "body_contains" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "json_path" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "json_equals" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "period_s" integer;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "grace_s" integer;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "last_ping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops"."monitors" ADD COLUMN "last_ping_kind" text;--> statement-breakpoint
ALTER TABLE "ops"."rollups_hourly" ADD COLUMN "maintenance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD CONSTRAINT "maintenance_windows_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."maintenance_windows" ADD CONSTRAINT "maintenance_windows_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."status_page_monitors" ADD CONSTRAINT "status_page_monitors_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "ops"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_monitors_badge" ON "ops"."status_page_monitors" USING btree ("page_id","badge_key");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_token_hash" ON "ops"."monitors" USING btree ("token_hash") WHERE token_hash is not null;