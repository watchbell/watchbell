-- Watchbell rename (20 Oct 2026): new console API keys start with wb_; keys made before keep their wp_ prefix and stay
-- valid, so the check accepts both. Widening only: rows and old code are unaffected.
alter table ops.api_keys drop constraint if exists api_keys_prefix_check;--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_prefix_check check (prefix ~ '^w[bp]_[A-Za-z0-9]{4}$');
