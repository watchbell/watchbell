-- Kantor Virtual (owner 14 Oct 03:30): the Claude Code hook's compact events, sent with a console key (write:notes) to
-- POST /api/v1/office/events and read back by the owner's /office page. Additive: one new table. Kept 24 h and at most
-- the newest 5,000 rows (daily step "office-retention").
CREATE TABLE "ops"."office_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"session" text NOT NULL,
	"project" text,
	"agent" text,
	"agent_type" text,
	"ev" text NOT NULL,
	"tool" text,
	"summary" text,
	"kind" text,
	"spawn" jsonb,
	"key_id" uuid
);
--> statement-breakpoint
CREATE INDEX "office_events_at_idx" ON "ops"."office_events" USING btree ("at");--> statement-breakpoint
-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.office_events enable row level security;--> statement-breakpoint
revoke all on ops.office_events from anon, authenticated;--> statement-breakpoint
grant select, insert, delete on ops.office_events to ops_app;--> statement-breakpoint
grant usage, select on sequence ops.office_events_id_seq to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.office_events for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the same bounds as the API's validation.
alter table ops.office_events add constraint office_events_ev_check check (ev in ('prompt', 'wake', 'tool', 'tool_done', 'notify', 'stop', 'sub_start', 'sub_stop'));--> statement-breakpoint
alter table ops.office_events add constraint office_events_session_check check (char_length(session) between 1 and 16);--> statement-breakpoint
alter table ops.office_events add constraint office_events_project_check check (project is null or char_length(project) <= 80);--> statement-breakpoint
alter table ops.office_events add constraint office_events_agent_check check (agent is null or char_length(agent) between 1 and 40);--> statement-breakpoint
alter table ops.office_events add constraint office_events_agent_type_check check (agent_type is null or char_length(agent_type) <= 60);--> statement-breakpoint
alter table ops.office_events add constraint office_events_tool_check check (tool is null or char_length(tool) <= 80);--> statement-breakpoint
alter table ops.office_events add constraint office_events_summary_check check (summary is null or char_length(summary) <= 200);--> statement-breakpoint
alter table ops.office_events add constraint office_events_kind_check check (kind is null or char_length(kind) <= 40);--> statement-breakpoint
alter table ops.office_events add constraint office_events_spawn_check check (spawn is null or (jsonb_typeof(spawn) = 'object' and octet_length(spawn::text) <= 1024));
