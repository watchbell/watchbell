CREATE TABLE "ops"."app_security" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"framework" text DEFAULT 'next' NOT NULL,
	"version" text,
	"status" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."app_security" ADD CONSTRAINT "app_security_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;