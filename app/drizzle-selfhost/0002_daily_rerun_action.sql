alter table ops.action_proposals drop constraint if exists action_proposals_action_check;--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_action_check check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback', 'github_bump_pr', 'domain_recheck', 'daily_rerun'));
