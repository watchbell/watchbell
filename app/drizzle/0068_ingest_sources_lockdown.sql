-- Watchbell 1.8.6 (Alertmanager in): same lock-down as every ops table — browser roles get nothing, the app role gets
-- one policy — plus the value checks drizzle-kit can't express (self-host has the same checks in 0015), and the rule
-- ExternalAlert (lib/alerts/catalog.ts) with MonitorDown's channels, else the default. ON CONFLICT DO NOTHING keeps an
-- owner's edits on a re-run.
alter table ops.ingest_sources enable row level security;--> statement-breakpoint
revoke all on ops.ingest_sources from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.ingest_sources to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.ingest_sources for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.ingest_sources add constraint ingest_sources_values_check check (kind in ('alertmanager') and char_length(name) between 1 and 40 and char_length(token_prefix) = 7 and (month_key is null or month_key ~ '^\d{4}-\d{2}$') and received_month >= 0 and refused_month >= 0);--> statement-breakpoint
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'ExternalAlert', 'warning', null,
    coalesce((select channels from ops.alert_rules where key = 'MonitorDown'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;
