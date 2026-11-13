-- Watchbell 1.7: the alert rule ReportSendFailed, the same seed row as the cloud migration 0064 (CollectorStale's channels, else the default).
insert into ops.alert_rules (key, severity, threshold, channels) select 'ReportSendFailed', 'warning', null, coalesce((select channels from ops.alert_rules where key = 'CollectorStale'), '["telegram","email_digest"]'::jsonb) on conflict (key) do nothing;
