-- Watchbell 1.2.3: two new notification channels, a generic outgoing webhook (n8n and anything else that takes a JSON
-- POST) and SMTP (alerts by email through your own mail server). The values only widen the enum; no row changes, and
-- rules opt in per rule like Discord.
ALTER TYPE "ops"."channel_kind" ADD VALUE 'webhook' BEFORE 'email_digest';--> statement-breakpoint
ALTER TYPE "ops"."channel_kind" ADD VALUE 'smtp' BEFORE 'email_digest';
