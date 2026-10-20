-- Stage 8 lock-down. 0042 adds enum values only: Turso, Upstash and D1 readings are stored in ops.snapshots and their
-- accounts in ops.accounts, both already locked down (0001), so there is no new table to revoke from anon/authenticated.
-- Re-assert the existing policies' grants so a partial earlier run can't leave the new kinds readable by browser roles.
revoke all on ops.accounts from anon, authenticated;--> statement-breakpoint
revoke all on ops.resources from anon, authenticated;--> statement-breakpoint
revoke all on ops.snapshots from anon, authenticated;--> statement-breakpoint
-- Stage 8's catalog rule (lib/alerts/catalog.ts DbQuotaHigh): a Turso, Upstash or D1 database past T% of a free-plan
-- usage quota (rows read or written, commands). Storage keeps using StorageAlmostFull. ON CONFLICT DO NOTHING keeps an
-- owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels) values
  ('DbQuotaHigh', 'warning', 80, '["telegram","email_digest"]')
on conflict (key) do nothing;
