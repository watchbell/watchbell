-- Owner 13 Nov: the memory breakdown (bytes) and the commitment (%) per hour, as Supabase's Observability › Database
-- charts them (lib/databases/compute-metrics.ts). Nullable: hours scraped before have none.
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "mem_total_b" double precision;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "mem_used_b" double precision;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "mem_cache_b" double precision;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "swap_b" double precision;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "commit_pct" real;--> statement-breakpoint
ALTER TABLE "ops"."supabase_metrics" ADD COLUMN "commit_max" real;