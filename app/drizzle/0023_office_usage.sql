-- Kantor Virtual token counts (owner 14 Oct): stop / sub_stop events carry the tokens the hook read (read-only) from
-- Claude Code's own transcript, numbers and a model name only. Additive: one nullable column, nothing dropped.
ALTER TABLE "ops"."office_events" ADD COLUMN "usage" jsonb;--> statement-breakpoint
-- Same bounds as the API's validation (drizzle-kit can't express them).
alter table ops.office_events add constraint office_events_usage_check check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512));--> statement-breakpoint
-- Kantor Virtual "Ask" (owner 14 Oct): a question for the Manager (the real Claude Code session) waits in the AI inbox
-- as purpose 'office'; only the local Claude Code hook reads it (GET /api/v1/office/questions), never the Ask page or
-- the MCP inbox. The check is widened (existing rows are all 'ask' or 'ping'); nothing else changes.
alter table ops.ai_questions drop constraint if exists ai_questions_purpose_check;--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_purpose_check check (purpose in ('ask', 'ping', 'office'));
