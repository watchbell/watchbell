-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.maintenance_windows enable row level security;
revoke all on ops.maintenance_windows from anon, authenticated;
grant select, insert, update, delete on ops.maintenance_windows to ops_app;
create policy ops_app_all on ops.maintenance_windows for all to ops_app using (true) with check (true);
alter table ops.recommendation_dismissals enable row level security;
revoke all on ops.recommendation_dismissals from anon, authenticated;
grant select, insert, update, delete on ops.recommendation_dismissals to ops_app;
create policy ops_app_all on ops.recommendation_dismissals for all to ops_app using (true) with check (true);
alter table ops.status_pages enable row level security;
revoke all on ops.status_pages from anon, authenticated;
grant select, insert, update, delete on ops.status_pages to ops_app;
create policy ops_app_all on ops.status_pages for all to ops_app using (true) with check (true);
alter table ops.status_page_monitors enable row level security;
revoke all on ops.status_page_monitors from anon, authenticated;
grant select, insert, update, delete on ops.status_page_monitors to ops_app;
create policy ops_app_all on ops.status_page_monitors for all to ops_app using (true) with check (true);

-- Value checks, as for the other enums (drizzle-kit can't express them).
alter table ops.monitors add constraint monitors_kind_check check (kind in ('http', 'heartbeat'));
alter table ops.monitors add constraint monitors_ping_kind_check check (last_ping_kind is null or last_ping_kind in ('ok', 'fail', 'start'));
alter table ops.monitors add constraint monitors_heartbeat_check check (kind = 'http' or (token_hash is not null and period_s > 0 and grace_s > 0));
alter table ops.maintenance_windows add constraint maintenance_windows_scope_check check (scope in ('all', 'app', 'monitor'));
alter table ops.maintenance_windows add constraint maintenance_windows_duration_check check (duration_min between 5 and 10080);
alter table ops.status_pages add constraint status_pages_slug_check check (slug ~ '^[a-z0-9-]{3,40}$');
