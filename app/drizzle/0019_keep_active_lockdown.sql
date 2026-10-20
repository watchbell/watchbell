-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.keep_active enable row level security;
revoke all on ops.keep_active from anon, authenticated;
grant select, insert, update, delete on ops.keep_active to ops_app;
create policy ops_app_all on ops.keep_active for all to ops_app using (true) with check (true);
