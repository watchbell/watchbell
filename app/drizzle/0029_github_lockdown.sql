-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.github_repos enable row level security;--> statement-breakpoint
revoke all on ops.github_repos from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.github_repos to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.github_repos for all to ops_app using (true) with check (true);--> statement-breakpoint
alter table ops.app_repos enable row level security;--> statement-breakpoint
revoke all on ops.app_repos from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.app_repos to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.app_repos for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value check (drizzle-kit can't express it): where a link came from.
alter table ops.app_repos add constraint app_repos_source_check check (source in ('vercel', 'manual'));
