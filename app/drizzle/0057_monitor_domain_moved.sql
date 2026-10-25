-- Watchbell 1.2.1: domain-change awareness. The alert rule MonitorDomainMoved (lib/alerts/catalog.ts): an uptime monitor
-- still checks a domain its app no longer has; it fires instead of MonitorDown for that monitor. Seed row only, with the
-- owner's MonitorDown channels when that row exists, else the default channels of the other warning rules. ON CONFLICT
-- DO NOTHING keeps an owner's edits on a re-run. The safe proposal monitor_update_url (point the monitor at the app's
-- new domain, keeping the path) joins the allowed actions.
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'MonitorDomainMoved', 'warning', null,
    coalesce((select channels from ops.alert_rules where key = 'MonitorDown'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;--> statement-breakpoint
alter table ops.action_proposals drop constraint if exists action_proposals_action_check;--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_action_check check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback', 'github_bump_pr', 'domain_recheck', 'daily_rerun', 'monitor_update_url'));
