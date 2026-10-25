-- Watchbell 1.2 (owner 23 Oct): the alert rule FrameworkVulnerable (lib/alerts/catalog.ts), raised from the Security
-- card's Next.js check (ops.app_security status 'vulnerable'). Seed row only: no new table, column or check. Default on,
-- with the owner's channels of VulnerableDependency (the other security rule) when that row exists, else the default
-- channels of the other warning rules. ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'FrameworkVulnerable', 'warning', null,
    coalesce((select channels from ops.alert_rules where key = 'VulnerableDependency'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;
