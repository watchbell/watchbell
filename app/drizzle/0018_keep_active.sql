CREATE TABLE "ops"."keep_active" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"keep" boolean DEFAULT false NOT NULL,
	"auto_restore" boolean DEFAULT false NOT NULL,
	"last_keep_alive_at" timestamp with time zone,
	"last_auto_restore_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."keep_active" ADD CONSTRAINT "keep_active_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;