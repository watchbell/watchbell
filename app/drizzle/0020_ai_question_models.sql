-- Antigravity models (owner 13 Oct): a question may ask the VM for one model, and Watchpost's "Test" pings share the
-- inbox (purpose 'ping', hidden from the Ask page). Additive; old rows become purpose 'ask' with no requested model.
ALTER TABLE "ops"."ai_questions" ADD COLUMN IF NOT EXISTS "requested_model" text;--> statement-breakpoint
ALTER TABLE "ops"."ai_questions" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."ai_questions" ADD CONSTRAINT "ai_questions_requested_model_check" CHECK (requested_model is null or (char_length(requested_model) <= 120 and requested_model ~ '^[a-z0-9@/._-]+$'));--> statement-breakpoint
ALTER TABLE "ops"."ai_questions" ADD CONSTRAINT "ai_questions_purpose_check" CHECK (purpose in ('ask', 'ping'));
