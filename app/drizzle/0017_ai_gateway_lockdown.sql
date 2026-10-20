-- Same lock-down as every ops table: browser roles get nothing, the app role gets one policy.
alter table ops.api_keys enable row level security;
revoke all on ops.api_keys from anon, authenticated;
grant select, insert, update, delete on ops.api_keys to ops_app;
create policy ops_app_all on ops.api_keys for all to ops_app using (true) with check (true);
alter table ops.ai_providers enable row level security;
revoke all on ops.ai_providers from anon, authenticated;
grant select, insert, update, delete on ops.ai_providers to ops_app;
create policy ops_app_all on ops.ai_providers for all to ops_app using (true) with check (true);
alter table ops.ai_agents enable row level security;
revoke all on ops.ai_agents from anon, authenticated;
grant select, insert, update, delete on ops.ai_agents to ops_app;
create policy ops_app_all on ops.ai_agents for all to ops_app using (true) with check (true);
alter table ops.ai_usage enable row level security;
revoke all on ops.ai_usage from anon, authenticated;
grant select, insert, delete on ops.ai_usage to ops_app;
grant usage, select on sequence ops.ai_usage_id_seq to ops_app;
create policy ops_app_all on ops.ai_usage for all to ops_app using (true) with check (true);
alter table ops.ai_quota enable row level security;
revoke all on ops.ai_quota from anon, authenticated;
grant select, insert, update, delete on ops.ai_quota to ops_app;
create policy ops_app_all on ops.ai_quota for all to ops_app using (true) with check (true);

-- Value checks and partial indexes (drizzle-kit can't express them).
alter table ops.api_keys add constraint api_keys_name_check check (name ~ '^[a-z0-9-]{2,40}$');
alter table ops.api_keys add constraint api_keys_prefix_check check (prefix ~ '^wp_[A-Za-z0-9]{4}$');
alter table ops.api_keys add constraint api_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$');
alter table ops.api_keys add constraint api_keys_scopes_check check (scopes <@ array['ai:invoke', 'read:status', 'write:notes']::text[] and cardinality(scopes) > 0);
alter table ops.api_keys add constraint api_keys_rate_check check (rate_per_min between 1 and 600);
create unique index api_keys_active_name_key on ops.api_keys (name) where revoked_at is null;
alter table ops.ai_providers add constraint ai_providers_kind_check check (kind in ('cloudflare', 'groq', 'openrouter', 'gemini', 'custom'));
alter table ops.ai_providers add constraint ai_providers_base_url_check check (base_url ~ '^https://');
create unique index ai_providers_default_one on ops.ai_providers ((true)) where is_default;
create unique index ai_providers_kind_one on ops.ai_providers (kind) where kind <> 'custom';
alter table ops.ai_agents add constraint ai_agents_via_check check (via in ('mcp', 'x-client', 'user-agent', 'unknown', 'console'));
create unique index ai_agents_key_client_key on ops.ai_agents (coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid), client_name);
alter table ops.ai_usage add constraint ai_usage_kind_check check (kind in ('chat', 'models', 'mcp', 'status', 'me', 'console'));
alter table ops.ai_quota add constraint ai_quota_source_check check (source in ('header', 'own'));
alter table ops.ai_notes enable row level security;
revoke all on ops.ai_notes from anon, authenticated;
grant select, insert, update, delete on ops.ai_notes to ops_app;
create policy ops_app_all on ops.ai_notes for all to ops_app using (true) with check (true);
alter table ops.ai_notes add constraint ai_notes_severity_check check (severity in ('info', 'warn', 'crit'));
alter table ops.ai_notes add constraint ai_notes_title_check check (char_length(title) between 1 and 120);
alter table ops.ai_notes add constraint ai_notes_body_check check (octet_length(body) <= 4096);
alter table ops.ai_notes add constraint ai_notes_model_check check (model is null or char_length(model) <= 120);
alter table ops.ai_notes add constraint ai_notes_client_check check (client is null or char_length(client) <= 80);

-- Owner 13 Oct 07:35: questions the console asks the AI brain (Antigravity over MCP), bounded like ai_notes.
alter table ops.ai_questions enable row level security;
revoke all on ops.ai_questions from anon, authenticated;
grant select, insert, update, delete on ops.ai_questions to ops_app;
create policy ops_app_all on ops.ai_questions for all to ops_app using (true) with check (true);
alter table ops.ai_questions add constraint ai_questions_context_kind_check check (context_kind in ('app', 'alert', 'general'));
alter table ops.ai_questions add constraint ai_questions_status_check check (status in ('pending', 'answered', 'expired'));
alter table ops.ai_questions add constraint ai_questions_question_check check (char_length(question) between 1 and 2000);
alter table ops.ai_questions add constraint ai_questions_answer_check check (answer is null or char_length(answer) <= 8000);
alter table ops.ai_questions add constraint ai_questions_answered_by_client_check check (answered_by_client is null or char_length(answered_by_client) <= 80);
alter table ops.ai_questions add constraint ai_questions_answered_by_model_check check (answered_by_model is null or char_length(answered_by_model) <= 120);
