-- Stage 9 slice 4 lock-down: the same as every ops table (browser roles get nothing, the app role gets one policy),
-- one active runner at a time, and the value checks drizzle-kit can't express (bounds as lib/runner/*.ts).
alter table ops.runners enable row level security;--> statement-breakpoint
revoke all on ops.runners from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.runners to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.runners for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.runner_repo_settings enable row level security;--> statement-breakpoint
revoke all on ops.runner_repo_settings from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.runner_repo_settings to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.runner_repo_settings for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.runner_jobs enable row level security;--> statement-breakpoint
revoke all on ops.runner_jobs from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.runner_jobs to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.runner_jobs for all to ops_app using (true) with check (true);--> statement-breakpoint
-- One runner token in force at a time (issuing a new one revokes the old in the same transaction).
create unique index runners_one_active on ops.runners ((true)) where revoked_at is null;--> statement-breakpoint
alter table ops.runners add constraint runners_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
alter table ops.runners add constraint runners_token_prefix_check check (token_prefix ~ '^wr_[A-Za-z0-9]{4}$');--> statement-breakpoint
alter table ops.runners add constraint runners_version_check check (version is null or (char_length(version) <= 40 and version ~ '^[0-9A-Za-z.+-]+$'));--> statement-breakpoint
alter table ops.runners add constraint runners_host_check check (host is null or (char_length(host) <= 253 and host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'));--> statement-breakpoint
alter table ops.runner_repo_settings add constraint runner_repo_settings_app_port_check check (app_port between 1 and 65535);--> statement-breakpoint
alter table ops.runner_repo_settings add constraint runner_repo_settings_env_check check (jsonb_typeof(env) = 'object' and octet_length(env::text) <= 12288);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_kind_check check (kind in ('preview', 'lockfile'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_status_check check (status in ('queued', 'claimed', 'running', 'ready', 'stopping', 'stopped', 'succeeded', 'failed'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_sha_check check (sha ~ '^[0-9a-f]{40}$');--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_ref_check check (char_length(ref) between 1 and 200);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_port_check check (port is null or port between 4100 and 4199);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_url_check check (url is null or (char_length(url) <= 300 and url ~ '^http://[a-z0-9.-]+:41[0-9]{2}$'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_logs_check check (logs is null or char_length(logs) <= 40000);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_attempts_check check (attempts between 0 and 10);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_params_check check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 16384);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_archive_hash_check check (archive_token_hash is null or archive_token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- A lockfile job only ever targets Watchpost's own update branches.
alter table ops.runner_jobs add constraint runner_jobs_lockfile_ref_check check (kind <> 'lockfile' or ref ~ '^watchpost/deps-[0-9a-f]{8}$');
