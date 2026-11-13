-- Watchbell 1.7: the alert rule ReportSendFailed (lib/alerts/catalog.ts): a monthly client report that couldn't be
-- emailed on the 1st, 2nd or 3rd. CollectorStale's channels (the other rule about Watchbell's own work), else the
-- default. ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels)
  select 'ReportSendFailed', 'warning', null,
    coalesce((select channels from ops.alert_rules where key = 'CollectorStale'), '["telegram","email_digest"]'::jsonb)
on conflict (key) do nothing;
