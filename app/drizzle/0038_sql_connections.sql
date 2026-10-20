-- Stage 9 slice 2 (SQL console): the owner's sealed read-only connection string per Supabase or Neon database. RLS,
-- grants and value checks are in 0039. Additive only.
CREATE TABLE "ops"."sql_connections" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"dsn_ciphertext" text NOT NULL,
	"dsn_iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"role_name" text NOT NULL,
	"endpoint_id" text,
	"added_by" uuid,
	"verified_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."sql_connections" ADD CONSTRAINT "sql_connections_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;