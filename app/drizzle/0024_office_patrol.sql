-- Kantor Virtual "Patroli" (owner 14 Oct): the 9Router officers' results per room and the Manager's compiled report
-- are office events with ev 'patrol' (session 'patrol', agent = the room or 'report'), and full reports go to a new
-- inbox, ops.office_reports (source 'patrol' or 'manager'), kept 7 days (daily step "office-retention"). Additive:
-- one new table; the office_events ev check is widened (every existing row already passes it).
CREATE TABLE "ops"."office_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"rooms" jsonb,
	"model" text,
	"via" text,
	"usage" jsonb,
	"key_id" uuid,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "office_reports_at_idx" ON "ops"."office_reports" USING btree ("at");--> statement-breakpoint
-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.office_reports enable row level security;--> statement-breakpoint
revoke all on ops.office_reports from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.office_reports to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.office_reports for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the same bounds as the API's validation.
alter table ops.office_reports add constraint office_reports_source_check check (source in ('patrol', 'manager'));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_title_check check (char_length(title) between 1 and 120);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_body_check check (char_length(body) between 1 and 8000);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_rooms_check check (rooms is null or (jsonb_typeof(rooms) = 'array' and octet_length(rooms::text) <= 8192));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_model_check check (model is null or char_length(model) <= 120);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_via_check check (via is null or (char_length(via) <= 40 and via in ('local-claude', 'gemini', 'claude-code')));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_usage_check check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512));--> statement-breakpoint
-- Patroli rows in the office: ev also allows 'patrol'.
alter table ops.office_events drop constraint if exists office_events_ev_check;--> statement-breakpoint
alter table ops.office_events add constraint office_events_ev_check check (ev in ('prompt', 'wake', 'tool', 'tool_done', 'notify', 'stop', 'sub_start', 'sub_stop', 'patrol'));
