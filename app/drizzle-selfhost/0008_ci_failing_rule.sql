-- Watchbell 1.4: the alert rule CiFailing, the same seed row as the cloud migration 0059 (VulnerableDependency's channels, else the default).
insert into ops.alert_rules (key, severity, threshold, channels) select 'CiFailing', 'warning', null, coalesce((select channels from ops.alert_rules where key = 'VulnerableDependency'), '["telegram","email_digest"]'::jsonb) on conflict (key) do nothing;
