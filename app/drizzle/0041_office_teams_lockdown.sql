-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.news_items enable row level security;--> statement-breakpoint
revoke all on ops.news_items from anon, authenticated;--> statement-breakpoint
grant select, insert, update, delete on ops.news_items to ops_app;--> statement-breakpoint
create policy ops_app_all on ops.news_items for all to ops_app using (true) with check (true);--> statement-breakpoint
-- Value checks (drizzle-kit can't express them): the same bounds as teams/news-sources.ts.
alter table ops.news_items add constraint news_items_topic_check check (topic in ('tech', 'saham', 'emas', 'kurs', 'politik', 'bola'));--> statement-breakpoint
alter table ops.news_items add constraint news_items_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.news_items add constraint news_items_url_check check (char_length(url) between 1 and 1000 and url ~ '^https?://');--> statement-breakpoint
alter table ops.news_items add constraint news_items_source_check check (source is null or char_length(source) between 1 and 100);
