-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.app_security enable row level security;
revoke all on ops.app_security from anon, authenticated;
grant select, insert, update, delete on ops.app_security to ops_app;
create policy ops_app_all on ops.app_security for all to ops_app using (true) with check (true);
alter table ops.app_security add constraint app_security_status_check check (status in ('ok', 'vulnerable', 'unknown', 'error'));
