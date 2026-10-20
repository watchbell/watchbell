-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.alert_rules enable row level security;
revoke all on ops.alert_rules from anon, authenticated;
grant select, insert, update, delete on ops.alert_rules to ops_app;
create policy ops_app_all on ops.alert_rules for all to ops_app using (true) with check (true);
alter table ops.alerts enable row level security;
revoke all on ops.alerts from anon, authenticated;
grant select, insert, update, delete on ops.alerts to ops_app;
create policy ops_app_all on ops.alerts for all to ops_app using (true) with check (true);
alter table ops.channels enable row level security;
revoke all on ops.channels from anon, authenticated;
grant select, insert, update, delete on ops.channels to ops_app;
create policy ops_app_all on ops.channels for all to ops_app using (true) with check (true);
alter table ops.stored_logs enable row level security;
revoke all on ops.stored_logs from anon, authenticated;
grant select, insert, update, delete on ops.stored_logs to ops_app;
create policy ops_app_all on ops.stored_logs for all to ops_app using (true) with check (true);
alter table ops.provider_status enable row level security;
revoke all on ops.provider_status from anon, authenticated;
grant select, insert, update, delete on ops.provider_status to ops_app;
create policy ops_app_all on ops.provider_status for all to ops_app using (true) with check (true);

alter table ops.stored_logs add constraint stored_logs_level_check check (level in ('warning', 'error', 'fatal'));
alter table ops.alerts add constraint alerts_pending_check check (pending is null or pending in ('open', 'repeat', 'resolve'));
alter table ops.events add constraint events_count_check check (count >= 1);

-- The Events page and Overview order by the latest occurrence (R2).
create index events_recent on ops.events ((coalesce(last_at, at)) desc);

-- Spec §10 rules. The seed rows use ON CONFLICT DO NOTHING, so an owner's edits survive a re-run of this INSERT. The policy and
-- constraint statements above are not idempotent: run this file once.
insert into ops.alert_rules (key, severity, threshold, channels) values
  ('MonitorDown', 'critical', 3, '["telegram","email_digest"]'),
  ('CollectorStale', 'critical', 5, '["telegram","email_digest"]'),
  ('HighLatency', 'warning', 1500, '["telegram","email_digest"]'),
  ('DeploymentFailed', 'warning', null, '["telegram","email_digest"]'),
  ('DatabasePaused', 'warning', null, '["telegram","email_digest"]'),
  ('CertExpiringSoon', 'warning', 14, '["telegram","email_digest"]'),
  ('DomainExpiringSoon', 'warning', 30, '["telegram","email_digest"]'),
  ('StorageAlmostFull', 'warning', 80, '["telegram","email_digest"]'),
  ('NeonComputeHigh', 'warning', 80, '["telegram","email_digest"]'),
  ('FirestoreQuotaHigh', 'warning', 80, '["telegram","email_digest"]'),
  ('AutoPauseRisk', 'info', 4, '["email_digest"]'),
  ('DnsProxiedToVercel', 'info', null, '["email_digest"]'),
  ('CredentialExpiring', 'warning', 14, '["telegram","email_digest"]')
on conflict (key) do nothing;

-- R2 backfill: reasons for the events written before this stage (fixed messages only; the rest stay null).
update ops.events set reason = case
  when type = 'monitor' and message = 'Monitor down' then 'MonitorDown'
  when type = 'monitor' and message = 'Monitor degraded' then 'MonitorDegraded'
  when type = 'monitor' and message = 'Monitor recovered' then 'MonitorRecovered'
  when type = 'deployment' and message = 'Deployment started' then 'DeployStarted'
  when type = 'deployment' and message = 'Deployment ready' then 'DeployReady'
  when type = 'deployment' and message = 'Deployment failed' then 'DeployFailed'
  when type = 'deployment' and message = 'Deployment canceled' then 'DeployCanceled'
  when type = 'system' and message = 'Collector stopped' then 'CollectorStopped'
  when type = 'system' and message = 'Daily jobs finished' then 'DailyFinished'
  when type = 'system' and message = 'Daily jobs finished with problems' then 'DailyProblems'
  when type = 'system' and message like '% no longer has known Next.js vulnerabilities%' then 'NextClean'
  when type = 'system' and message like '% runs Next.js % known vulnerabilit%' then 'NextVulnerable'
  when type = 'action' then 'Action'
end where reason is null;
