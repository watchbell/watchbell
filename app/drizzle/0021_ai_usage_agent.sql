-- Usage & Analytics (owner 13 Oct): Antigravity's runs on the VM are reported over MCP (report_usage) and stored as
-- ai_usage rows of kind 'agent', with the cached-input and thinking token counts `agy --output-format json` reports.
-- Additive: two nullable columns (old rows stay null) and the kind check replaced by one that also allows 'agent'.
ALTER TABLE "ops"."ai_usage" ADD COLUMN IF NOT EXISTS "tokens_cached" integer;--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD COLUMN IF NOT EXISTS "tokens_thinking" integer;--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_tokens_cached_check" CHECK (tokens_cached is null or tokens_cached >= 0);--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_tokens_thinking_check" CHECK (tokens_thinking is null or tokens_thinking >= 0);--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" DROP CONSTRAINT IF EXISTS "ai_usage_kind_check";--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_kind_check" CHECK (kind in ('chat', 'models', 'mcp', 'status', 'me', 'console', 'agent'));
