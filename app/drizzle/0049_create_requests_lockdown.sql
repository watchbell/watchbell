-- Stage 6 create requests lock-down, like every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.create_requests enable row level security;--> statement-breakpoint
revoke all on ops.create_requests from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.create_requests to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.create_requests for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the contract's values (src/lib/create/types.ts) and bounds.
alter table ops.create_requests add constraint create_requests_type_check check (type in ('dns_record', 'neon_branch', 'supabase_project', 'firebase_project'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_provider_check check (provider in ('cloudflare', 'neon', 'supabase', 'firebase'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_status_check check (status in ('requested', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_target_label_check check (char_length(target_label) between 1 and 120);--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '25 hours');--> statement-breakpoint
-- Inputs and results are small objects of names and ids; never a password, token or key (the one-time database
-- password is generated at approval and only returned to the Owner once).
alter table ops.create_requests add constraint create_requests_inputs_check check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 4096 and not (inputs ?| array['db_pass', 'dbPass', 'password', 'secret', 'token', 'apiKey', 'api_key', 'refresh_token']));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_result_check check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 2048 and not (result ?| array['db_pass', 'dbPass', 'password', 'secret', 'token', 'apiKey', 'api_key', 'refresh_token'])));
