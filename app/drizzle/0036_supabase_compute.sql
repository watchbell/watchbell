-- Stage 12 (owner 16 Oct): compute of the Supabase projects from Supabase's Metrics API. Two new tables: the owner's sealed
-- per-project Secret API key with the latest scrape, and hourly rollups (3 days). RLS, grants, checks and the ComputeHigh
-- rule are in 0037. Additive only.
CREATE TABLE "ops"."supabase_metrics" (
	"resource_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"cpu_samples" integer DEFAULT 0 NOT NULL,
	"cpu_avg" real,
	"cpu_max" real,
	"mem_avg" real,
	"mem_max" real,
	"disk_pct" real,
	"conn_used" integer,
	"conn_max" integer,
	CONSTRAINT "supabase_metrics_resource_id_hour_pk" PRIMARY KEY("resource_id","hour")
);
--> statement-breakpoint
CREATE TABLE "ops"."supabase_metrics_keys" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"added_by" uuid,
	"latest" jsonb,
	"last_try_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD CONSTRAINT "supabase_metrics_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics_keys" ADD CONSTRAINT "supabase_metrics_keys_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supabase_metrics_hour_idx" ON "ops"."supabase_metrics" USING btree ("hour");
