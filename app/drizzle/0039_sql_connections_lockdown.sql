-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.sql_connections enable row level security;--> statement-breakpoint
revoke all on ops.sql_connections from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.sql_connections to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.sql_connections for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them).
alter table ops.sql_connections add constraint sql_connections_provider_check check (provider in ('supabase', 'neon'));--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_sealed_check check (char_length(dsn_ciphertext) between 1 and 4000 and char_length(dsn_iv) between 1 and 64);--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_role_check check (char_length(role_name) between 1 and 63);--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_endpoint_check check (endpoint_id is null or (provider = 'neon' and endpoint_id ~ '^ep-[a-z0-9-]{1,80}$'));
