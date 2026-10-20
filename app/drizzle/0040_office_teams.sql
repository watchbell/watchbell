-- Stage 10 (owner 16 Oct): the Kantor Virtual's report-writing teams. Their reports go to the inbox with source = the
-- team ('news', 'research', 'analytics', 'content'), and Berita Dunia keeps its headlines (title, link, publisher, time;
-- never an article) in a new table, at most 10 per topic per WIB day, one row per link per day. Additive: one table; the
-- office_reports source check widens (drop before add: a check can't be altered in place; every existing row passes it).
-- RLS, grants and the news_items value checks are in 0041.
CREATE TABLE "ops"."news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"source" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_url_day" ON "ops"."news_items" USING btree ("url","day");--> statement-breakpoint
CREATE INDEX "news_items_day_topic_idx" ON "ops"."news_items" USING btree ("day","topic");--> statement-breakpoint
alter table ops.office_reports drop constraint if exists office_reports_source_check;--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_source_check check (source in ('patrol', 'manager', 'meeting', 'news', 'research', 'analytics', 'content'));
