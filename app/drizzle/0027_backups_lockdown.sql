-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.backups enable row level security;--> statement-breakpoint
revoke all on ops.backups from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.backups to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.backups for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the statuses the backup runner writes, and the month key.
alter table ops.backups add constraint backups_status_check check (status in ('ok', 'partial', 'error'));--> statement-breakpoint
alter table ops.backups add constraint backups_month_check check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
