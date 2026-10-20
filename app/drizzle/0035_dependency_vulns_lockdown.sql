-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.dependency_scans enable row level security;--> statement-breakpoint
revoke all on ops.dependency_scans from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.dependency_scans to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.dependency_scans for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.dependency_vulns enable row level security;--> statement-breakpoint
revoke all on ops.dependency_vulns from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.dependency_vulns to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.dependency_vulns for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the scan's values and bounds (lib/deps/*).
alter table ops.dependency_vulns add constraint dependency_vulns_severity_check check (severity in ('critical', 'high', 'moderate', 'low', 'unknown'));--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_source_check check (source in ('osv', 'dependabot'));--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_summary_check check (char_length(summary) <= 200);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_package_check check (char_length(package) between 1 and 214);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_installed_check check (char_length(installed_version) between 1 and 100);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_vuln_id_check check (char_length(vuln_id) between 1 and 64);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_fixed_check check (fixed_version is null or char_length(fixed_version) <= 100);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_aliases_check check (cardinality(aliases) <= 20);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_note_check check (note is null or char_length(note) <= 300);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_path_check check (lockfile_path is null or char_length(lockfile_path) <= 200);--> statement-breakpoint
-- The 14th alert rule (lib/alerts/catalog.ts). ON CONFLICT DO NOTHING keeps an owner's edits on a re-run.
insert into ops.alert_rules (key, severity, threshold, channels) values
  ('VulnerableDependency', 'warning', null, '["telegram","email_digest"]')
on conflict (key) do nothing;
