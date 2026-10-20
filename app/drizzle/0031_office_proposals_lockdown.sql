-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.action_proposals enable row level security;--> statement-breakpoint
revoke all on ops.action_proposals from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.action_proposals to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.action_proposals for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the contract's values and the API's bounds.
alter table ops.action_proposals add constraint action_proposals_action_check check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_risk_check check (risk in ('safe', 'risky'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_status_check check (status in ('pending', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_room_check check (room in ('workloads', 'databases', 'network', 'observe', 'ai', 'admin'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_auto_check check (not auto or risk = 'safe');--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_reason_check check (char_length(reason) between 1 and 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_result_check check (result is null or char_length(result) <= 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_resource_name_check check (resource_name is null or char_length(resource_name) <= 120);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_target_ref_check check (target_ref is null or (char_length(target_ref) <= 120 and target_ref ~ '^[A-Za-z0-9_-]+$'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_proposed_by_check check (char_length(proposed_by) between 1 and 60);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_rule_key_check check (char_length(rule_key) between 1 and 80);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_resource_kind_check check (resource_kind is null or char_length(resource_kind) <= 40);
