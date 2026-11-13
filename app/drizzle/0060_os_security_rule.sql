-- Owner 12 Nov: the alert rule OsSecurityUpdate (lib/alerts/catalog.ts): a security update waiting on the machine a
-- self-hosted Watchbell runs on fixes a CVE scored 7+ (CVSS), or a newer kernel waits for a reboot. Seed row only (the
-- cloud edition never evaluates it). VulnerableDependency's channels (the other security rule), else the default.
-- ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'OsSecurityUpdate', 'warning', 7,
    coalesce((select channels from ops.alert_rules where key = 'VulnerableDependency'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;
