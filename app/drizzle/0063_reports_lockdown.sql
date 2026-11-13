-- Watchbell 1.7 (monthly client report): same lock-down as every ops table — browser roles get nothing, the app role
-- gets one policy — plus the value checks drizzle-kit can't express.
alter table ops.reports enable row level security;--> statement-breakpoint
revoke all on ops.reports from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.reports to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.reports for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.report_sites enable row level security;--> statement-breakpoint
revoke all on ops.report_sites from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.report_sites to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.report_sites for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.report_sends enable row level security;--> statement-breakpoint
revoke all on ops.report_sends from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.report_sends to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.report_sends for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.deploy_days enable row level security;--> statement-breakpoint
revoke all on ops.deploy_days from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.deploy_days to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.deploy_days for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.reports add constraint reports_values_check check (
  char_length(client_name) between 1 and 120 and (title is null or char_length(title) <= 120) and
  (note is null or char_length(note) <= 1000) and (email_opening is null or char_length(email_opening) <= 500) and
  jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) <= 5 and lang in ('id', 'en') and
  (sender is null or sender in ('smtp', 'resend')));--> statement-breakpoint
alter table ops.report_sites add constraint report_sites_values_check check (char_length(display_name) between 1 and 80 and position >= 0);--> statement-breakpoint
alter table ops.report_sends add constraint report_sends_values_check check (
  month ~ '^\d{4}-\d{2}$' and status in ('claimed', 'sent', 'failed') and attempts >= 0 and
  (last_error is null or char_length(last_error) <= 300));--> statement-breakpoint
alter table ops.deploy_days add constraint deploy_days_values_check check (day ~ '^\d{4}-\d{2}-\d{2}$' and ok >= 0 and failed >= 0);
