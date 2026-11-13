-- Watchbell 1.4: the alert rule CiFailing (lib/alerts/catalog.ts), the latest GitHub Actions run on a linked
-- repository's default branch failed (github_repos.actions, read in the daily sync). Seed row only: no new table, column
-- or check. Default on, with the owner's channels of VulnerableDependency (the other GitHub rule) when that row exists,
-- else the default channels of the other warning rules. ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'CiFailing', 'warning', null,
    coalesce((select channels from ops.alert_rules where key = 'VulnerableDependency'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;
