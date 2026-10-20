-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.dev_notes enable row level security;--> statement-breakpoint
revoke all on ops.dev_notes from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.dev_notes to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.dev_notes for all to ops_app using (true) with check (true);--> statement-breakpoint
-- At most one open (queued or running) note per app: a second request answers 409.
create unique index dev_notes_one_open_per_app on ops.dev_notes (app_id) where status in ('queued', 'running');--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the contract's values and limits.
alter table ops.dev_notes add constraint dev_notes_trigger_check check (trigger in ('manual', 'auto'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_status_check check (status in ('queued', 'running', 'done', 'failed', 'skipped'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_confidence_check check (confidence is null or confidence in ('low', 'medium', 'high'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_question_check check (char_length(question) between 1 and 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_summary_check check (summary is null or char_length(summary) <= 400);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_cause_check check (cause is null or char_length(cause) <= 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_patch_check check (patch is null or char_length(patch) <= 4000);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_error_check check (error is null or char_length(error) <= 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_model_check check (model is null or char_length(model) <= 120);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_repo_check check (repo is null or char_length(repo) <= 201);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_ref_check check (ref is null or char_length(ref) <= 64);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_files_check check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 5 and octet_length(files::text) <= 2048);
