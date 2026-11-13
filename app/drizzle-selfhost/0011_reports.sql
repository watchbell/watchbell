CREATE TABLE "ops"."deploy_days" (
	"resource_id" uuid NOT NULL,
	"day" text NOT NULL,
	"ok" integer NOT NULL,
	"failed" integer NOT NULL,
	CONSTRAINT "deploy_days_resource_id_day_pk" PRIMARY KEY("resource_id","day")
);
--> statement-breakpoint
CREATE TABLE "ops"."report_sends" (
	"report_id" uuid NOT NULL,
	"month" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "report_sends_report_id_month_pk" PRIMARY KEY("report_id","month")
);
--> statement-breakpoint
CREATE TABLE "ops"."report_sites" (
	"report_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "report_sites_report_id_monitor_id_pk" PRIMARY KEY("report_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_name" text NOT NULL,
	"title" text,
	"lang" text DEFAULT 'en' NOT NULL,
	"note" text,
	"email_opening" text,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"sender" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."deploy_days" ADD CONSTRAINT "deploy_days_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_sends" ADD CONSTRAINT "report_sends_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "ops"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_sites" ADD CONSTRAINT "report_sites_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "ops"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_sites" ADD CONSTRAINT "report_sites_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "ops"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Same value checks as the cloud's 0063_reports_lockdown.sql (no RLS here: one app role).
alter table ops.reports add constraint reports_values_check check (
  char_length(client_name) between 1 and 120 and (title is null or char_length(title) <= 120) and
  (note is null or char_length(note) <= 1000) and (email_opening is null or char_length(email_opening) <= 500) and
  jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) <= 5 and lang in ('id', 'en') and
  (sender is null or sender in ('smtp', 'resend')));--> statement-breakpoint
alter table ops.report_sites add constraint report_sites_values_check check (char_length(display_name) between 1 and 80 and position >= 0);--> statement-breakpoint
alter table ops.report_sends add constraint report_sends_values_check check (
  month ~ '^\d{4}-\d{2}$' and status in ('claimed', 'sent', 'failed') and attempts >= 0 and
  (last_error is null or char_length(last_error) <= 300));--> statement-breakpoint
alter table ops.deploy_days add constraint deploy_days_values_check check (day ~ '^\d{4}-\d{2}-\d{2}$' and ok >= 0 and failed >= 0);
