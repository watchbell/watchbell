-- Stage 8 (Later): more free databases to watch. Turso and Upstash connect as their own accounts (sealed token, like
-- Neon); Cloudflare D1 databases sit under the existing Cloudflare account. Their readings live in ops.snapshots.data
-- like every other database, so no new table is needed. Enum values only; the DbQuotaHigh rule is seeded in 0043
-- (a new enum value can't be used in the transaction that adds it). Additive only.
ALTER TYPE "ops"."provider" ADD VALUE IF NOT EXISTS 'turso';--> statement-breakpoint
ALTER TYPE "ops"."provider" ADD VALUE IF NOT EXISTS 'upstash';--> statement-breakpoint
ALTER TYPE "ops"."resource_kind" ADD VALUE IF NOT EXISTS 'turso_database';--> statement-breakpoint
ALTER TYPE "ops"."resource_kind" ADD VALUE IF NOT EXISTS 'upstash_redis';--> statement-breakpoint
ALTER TYPE "ops"."resource_kind" ADD VALUE IF NOT EXISTS 'd1_database';
