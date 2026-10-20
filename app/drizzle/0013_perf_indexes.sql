-- Perf P4 (13 Oct 2026): indexes for the hot reads that scanned checks, deployments or events without one. Additive
-- only, IF NOT EXISTS, no CONCURRENTLY (the tables are small at owner scale; a plain build takes a moment).
-- checks_at: Overview health (24 h across every monitor), the daily rollup and the 7-day retention read by time alone.
CREATE INDEX IF NOT EXISTS "checks_at" ON "ops"."checks" USING btree ("at");--> statement-breakpoint
-- deployments_created: the Deployments page (newest 200 across apps), Overview's ongoing builds and 24 h deploy count,
-- and retention.
CREATE INDEX IF NOT EXISTS "deployments_created" ON "ops"."deployments" USING btree ("created_at_provider");--> statement-breakpoint
-- events_latest: Overview's recent events and the Events page, ORDER BY coalesce(last_at, at) DESC LIMIT n on every
-- refresh (events_at is on "at" alone, which that order can't use).
CREATE INDEX IF NOT EXISTS "events_latest" ON "ops"."events" USING btree (coalesce("last_at", "at"));
