-- Watchbell 1.8 (workspaces): same lock-down as every ops table — browser roles get nothing, the app role gets one
-- policy — plus the value checks drizzle-kit can't express (self-host has the same checks in 0013).
alter table ops.workspaces enable row level security;--> statement-breakpoint
revoke all on ops.workspaces from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.workspaces to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.workspaces for all to ops_app using (true) with check (true);--> statement-breakpoint
revoke all on function ops.default_workspace_id() from public, anon, authenticated;--> statement-breakpoint
grant execute on function ops.default_workspace_id() to ops_app;--> statement-breakpoint
alter table ops.workspaces add constraint workspaces_values_check check (char_length(name) between 1 and 60 and name = btrim(name) and position >= 0);--> statement-breakpoint
create unique index workspaces_name_lower on ops.workspaces (lower(name));--> statement-breakpoint
alter table ops.maintenance_windows drop constraint maintenance_windows_scope_check;--> statement-breakpoint
alter table ops.maintenance_windows add constraint maintenance_windows_scope_check check (scope in ('all', 'app', 'monitor', 'workspace') and ((scope = 'workspace') = (workspace_id is not null)));
