-- Auto-rollback after a bad production deploy (owner 16 Oct): an owner-enabled office auto-run may roll production back
-- (vercel_rollback, a risky kind) inside the first N minutes of a new deploy. Every other risky kind still always waits
-- for the owner. Replaces only this one check; no data changes (every existing row already passes the wider check).
alter table ops.action_proposals drop constraint if exists action_proposals_auto_check;--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_auto_check check (not auto or risk = 'safe' or action = 'vercel_rollback');
