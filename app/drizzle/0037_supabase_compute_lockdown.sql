-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.supabase_metrics_keys enable row level security;--> statement-breakpoint
revoke all on ops.supabase_metrics_keys from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.supabase_metrics_keys to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.supabase_metrics_keys for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.supabase_metrics enable row level security;--> statement-breakpoint
revoke all on ops.supabase_metrics from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.supabase_metrics to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.supabase_metrics for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them).
alter table ops.supabase_metrics_keys add constraint supabase_metrics_keys_last_error_check check (last_error is null or char_length(last_error) <= 300);--> statement-breakpoint
alter table ops.supabase_metrics_keys add constraint supabase_metrics_keys_sealed_check check (char_length(key_ciphertext) between 1 and 2000 and char_length(key_iv) between 1 and 64);--> statement-breakpoint
alter table ops.supabase_metrics add constraint supabase_metrics_samples_check check (samples >= 0 and cpu_samples >= 0 and cpu_samples <= samples);--> statement-breakpoint
alter table ops.supabase_metrics add constraint supabase_metrics_pct_check check (
  (cpu_avg is null or cpu_avg between 0 and 100) and (cpu_max is null or cpu_max between 0 and 100) and
  (mem_avg is null or mem_avg between 0 and 100) and (mem_max is null or mem_max between 0 and 100) and
  (disk_pct is null or disk_pct between 0 and 100) and (conn_used is null or conn_used >= 0) and (conn_max is null or conn_max >= 0));--> statement-breakpoint
-- Stage 12's catalog rule (lib/alerts/catalog.ts ComputeHigh). ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels) values
  ('ComputeHigh', 'warning', 80, '["telegram","email_digest"]')
on conflict (key) do nothing;
