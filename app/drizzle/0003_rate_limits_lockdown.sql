-- Same lock-down as the other ops tables: browser roles get nothing, the app role gets one policy.
alter table ops.rate_limits enable row level security;
revoke all on ops.rate_limits from anon, authenticated;
grant select, insert, update, delete on ops.rate_limits to ops_app;
create policy ops_app_all on ops.rate_limits for all to ops_app using (true) with check (true);
