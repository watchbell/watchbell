-- Hand-written objects from the cloud history (app/drizzle) that drizzle-kit can't express: CHECK constraints,
-- partial and expression unique indexes, and the alert rule seeds. No Supabase roles, grants, policies or RLS.
-- src/db/selfhost-baseline.test.ts fails when app/drizzle gains an index or check that is missing here.
alter table ops.app_security add constraint app_security_status_check check (status in ('ok', 'vulnerable', 'unknown', 'error'));--> statement-breakpoint
alter table ops.stored_logs add constraint stored_logs_level_check check (level in ('warning', 'error', 'fatal'));--> statement-breakpoint
alter table ops.alerts add constraint alerts_pending_check check (pending is null or pending in ('open', 'repeat', 'resolve'));--> statement-breakpoint
alter table ops.events add constraint events_count_check check (count >= 1);--> statement-breakpoint
alter table ops.monitors add constraint monitors_kind_check check (kind in ('http', 'heartbeat'));--> statement-breakpoint
alter table ops.monitors add constraint monitors_ping_kind_check check (last_ping_kind is null or last_ping_kind in ('ok', 'fail', 'start'));--> statement-breakpoint
alter table ops.monitors add constraint monitors_heartbeat_check check (kind = 'http' or (token_hash is not null and period_s > 0 and grace_s > 0));--> statement-breakpoint
alter table ops.maintenance_windows add constraint maintenance_windows_scope_check check (scope in ('all', 'app', 'monitor'));--> statement-breakpoint
alter table ops.maintenance_windows add constraint maintenance_windows_duration_check check (duration_min between 5 and 10080);--> statement-breakpoint
alter table ops.status_pages add constraint status_pages_slug_check check (slug ~ '^[a-z0-9-]{3,40}$');--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_name_check check (name ~ '^[a-z0-9-]{2,40}$');--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_prefix_check check (prefix ~ '^wp_[A-Za-z0-9]{4}$');--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_scopes_check check (scopes <@ array['ai:invoke', 'read:status', 'write:notes']::text[] and cardinality(scopes) > 0);--> statement-breakpoint
alter table ops.api_keys add constraint api_keys_rate_check check (rate_per_min between 1 and 600);--> statement-breakpoint
alter table ops.ai_providers add constraint ai_providers_kind_check check (kind in ('cloudflare', 'groq', 'openrouter', 'gemini', 'custom'));--> statement-breakpoint
alter table ops.ai_providers add constraint ai_providers_base_url_check check (base_url ~ '^https://');--> statement-breakpoint
alter table ops.ai_agents add constraint ai_agents_via_check check (via in ('mcp', 'x-client', 'user-agent', 'unknown', 'console'));--> statement-breakpoint
alter table ops.ai_quota add constraint ai_quota_source_check check (source in ('header', 'own'));--> statement-breakpoint
alter table ops.ai_notes add constraint ai_notes_severity_check check (severity in ('info', 'warn', 'crit'));--> statement-breakpoint
alter table ops.ai_notes add constraint ai_notes_title_check check (char_length(title) between 1 and 120);--> statement-breakpoint
alter table ops.ai_notes add constraint ai_notes_body_check check (octet_length(body) <= 4096);--> statement-breakpoint
alter table ops.ai_notes add constraint ai_notes_model_check check (model is null or char_length(model) <= 120);--> statement-breakpoint
alter table ops.ai_notes add constraint ai_notes_client_check check (client is null or char_length(client) <= 80);--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_context_kind_check check (context_kind in ('app', 'alert', 'general'));--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_status_check check (status in ('pending', 'answered', 'expired'));--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_question_check check (char_length(question) between 1 and 2000);--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_answer_check check (answer is null or char_length(answer) <= 8000);--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_answered_by_client_check check (answered_by_client is null or char_length(answered_by_client) <= 80);--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_answered_by_model_check check (answered_by_model is null or char_length(answered_by_model) <= 120);--> statement-breakpoint
ALTER TABLE "ops"."ai_questions" ADD CONSTRAINT "ai_questions_requested_model_check" CHECK (requested_model is null or (char_length(requested_model) <= 120 and requested_model ~ '^[a-z0-9@/._-]+$'));--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_tokens_cached_check" CHECK (tokens_cached is null or tokens_cached >= 0);--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_tokens_thinking_check" CHECK (tokens_thinking is null or tokens_thinking >= 0);--> statement-breakpoint
ALTER TABLE "ops"."ai_usage" ADD CONSTRAINT "ai_usage_kind_check" CHECK (kind in ('chat', 'models', 'mcp', 'status', 'me', 'console', 'agent'));--> statement-breakpoint
alter table ops.office_events add constraint office_events_session_check check (char_length(session) between 1 and 16);--> statement-breakpoint
alter table ops.office_events add constraint office_events_project_check check (project is null or char_length(project) <= 80);--> statement-breakpoint
alter table ops.office_events add constraint office_events_agent_check check (agent is null or char_length(agent) between 1 and 40);--> statement-breakpoint
alter table ops.office_events add constraint office_events_agent_type_check check (agent_type is null or char_length(agent_type) <= 60);--> statement-breakpoint
alter table ops.office_events add constraint office_events_tool_check check (tool is null or char_length(tool) <= 80);--> statement-breakpoint
alter table ops.office_events add constraint office_events_summary_check check (summary is null or char_length(summary) <= 200);--> statement-breakpoint
alter table ops.office_events add constraint office_events_kind_check check (kind is null or char_length(kind) <= 40);--> statement-breakpoint
alter table ops.office_events add constraint office_events_spawn_check check (spawn is null or (jsonb_typeof(spawn) = 'object' and octet_length(spawn::text) <= 1024));--> statement-breakpoint
alter table ops.office_events add constraint office_events_usage_check check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512));--> statement-breakpoint
alter table ops.ai_questions add constraint ai_questions_purpose_check check (purpose in ('ask', 'ping', 'office'));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_title_check check (char_length(title) between 1 and 120);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_body_check check (char_length(body) between 1 and 8000);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_rooms_check check (rooms is null or (jsonb_typeof(rooms) = 'array' and octet_length(rooms::text) <= 8192));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_model_check check (model is null or char_length(model) <= 120);--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_via_check check (via is null or (char_length(via) <= 40 and via in ('local-claude', 'gemini', 'claude-code')));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_usage_check check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512));--> statement-breakpoint
alter table ops.office_events add constraint office_events_ev_check check (ev in ('prompt', 'wake', 'tool', 'tool_done', 'notify', 'stop', 'sub_start', 'sub_stop', 'patrol'));--> statement-breakpoint
alter table ops.backups add constraint backups_status_check check (status in ('ok', 'partial', 'error'));--> statement-breakpoint
alter table ops.backups add constraint backups_month_check check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
alter table ops.app_repos add constraint app_repos_source_check check (source in ('vercel', 'manual'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_risk_check check (risk in ('safe', 'risky'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_status_check check (status in ('pending', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_room_check check (room in ('workloads', 'databases', 'network', 'observe', 'ai', 'admin'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_reason_check check (char_length(reason) between 1 and 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_result_check check (result is null or char_length(result) <= 200);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_resource_name_check check (resource_name is null or char_length(resource_name) <= 120);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_target_ref_check check (target_ref is null or (char_length(target_ref) <= 120 and target_ref ~ '^[A-Za-z0-9_-]+$'));--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_proposed_by_check check (char_length(proposed_by) between 1 and 60);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_rule_key_check check (char_length(rule_key) between 1 and 80);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_resource_kind_check check (resource_kind is null or char_length(resource_kind) <= 40);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_trigger_check check (trigger in ('manual', 'auto'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_status_check check (status in ('queued', 'running', 'done', 'failed', 'skipped'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_confidence_check check (confidence is null or confidence in ('low', 'medium', 'high'));--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_question_check check (char_length(question) between 1 and 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_summary_check check (summary is null or char_length(summary) <= 400);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_cause_check check (cause is null or char_length(cause) <= 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_patch_check check (patch is null or char_length(patch) <= 4000);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_error_check check (error is null or char_length(error) <= 200);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_model_check check (model is null or char_length(model) <= 120);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_repo_check check (repo is null or char_length(repo) <= 201);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_ref_check check (ref is null or char_length(ref) <= 64);--> statement-breakpoint
alter table ops.dev_notes add constraint dev_notes_files_check check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 5 and octet_length(files::text) <= 2048);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_action_check check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback', 'github_bump_pr'));--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_severity_check check (severity in ('critical', 'high', 'moderate', 'low', 'unknown'));--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_source_check check (source in ('osv', 'dependabot'));--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_summary_check check (char_length(summary) <= 200);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_package_check check (char_length(package) between 1 and 214);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_installed_check check (char_length(installed_version) between 1 and 100);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_vuln_id_check check (char_length(vuln_id) between 1 and 64);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_fixed_check check (fixed_version is null or char_length(fixed_version) <= 100);--> statement-breakpoint
alter table ops.dependency_vulns add constraint dependency_vulns_aliases_check check (cardinality(aliases) <= 20);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_note_check check (note is null or char_length(note) <= 300);--> statement-breakpoint
alter table ops.dependency_scans add constraint dependency_scans_path_check check (lockfile_path is null or char_length(lockfile_path) <= 200);--> statement-breakpoint
alter table ops.supabase_metrics_keys add constraint supabase_metrics_keys_last_error_check check (last_error is null or char_length(last_error) <= 300);--> statement-breakpoint
alter table ops.supabase_metrics_keys add constraint supabase_metrics_keys_sealed_check check (char_length(key_ciphertext) between 1 and 2000 and char_length(key_iv) between 1 and 64);--> statement-breakpoint
alter table ops.supabase_metrics add constraint supabase_metrics_samples_check check (samples >= 0 and cpu_samples >= 0 and cpu_samples <= samples);--> statement-breakpoint
alter table ops.supabase_metrics add constraint supabase_metrics_pct_check check ( (cpu_avg is null or cpu_avg between 0 and 100) and (cpu_max is null or cpu_max between 0 and 100) and (mem_avg is null or mem_avg between 0 and 100) and (mem_max is null or mem_max between 0 and 100) and (disk_pct is null or disk_pct between 0 and 100) and (conn_used is null or conn_used >= 0) and (conn_max is null or conn_max >= 0));--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_provider_check check (provider in ('supabase', 'neon'));--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_sealed_check check (char_length(dsn_ciphertext) between 1 and 4000 and char_length(dsn_iv) between 1 and 64);--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_role_check check (char_length(role_name) between 1 and 63);--> statement-breakpoint
alter table ops.sql_connections add constraint sql_connections_endpoint_check check (endpoint_id is null or (provider = 'neon' and endpoint_id ~ '^ep-[a-z0-9-]{1,80}$'));--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_source_check check (source in ('patrol', 'manager', 'meeting', 'news', 'research', 'analytics', 'content'));--> statement-breakpoint
alter table ops.news_items add constraint news_items_topic_check check (topic in ('tech', 'saham', 'emas', 'kurs', 'politik', 'bola'));--> statement-breakpoint
alter table ops.news_items add constraint news_items_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.news_items add constraint news_items_url_check check (char_length(url) between 1 and 1000 and url ~ '^https?://');--> statement-breakpoint
alter table ops.news_items add constraint news_items_source_check check (source is null or char_length(source) between 1 and 100);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_stage_check check (stage in ('checks', 'preview', 'smoke', 'merging', 'merged', 'ready-manual', 'failed', 'timeout', 'closed'));--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_smoke_mode_check check (smoke_mode is null or smoke_mode in ('http', 'logs'));--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_branch_check check (branch ~ '^watchpost/deps-[0-9a-f]{8}$');--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_head_sha_check check (head_sha ~ '^[0-9a-f]{40}$');--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_number_check check (number > 0);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_title_check check (char_length(title) between 1 and 200);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_stage_text_check check (stage_text is null or char_length(stage_text) <= 200);--> statement-breakpoint
alter table ops.dependency_prs add constraint dependency_prs_packages_check check (jsonb_typeof(packages) = 'array' and octet_length(packages::text) <= 4096);--> statement-breakpoint
alter table ops.action_proposals add constraint action_proposals_auto_check check (not auto or risk = 'safe' or action in ('vercel_rollback', 'github_bump_pr'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_type_check check (type in ('dns_record', 'neon_branch', 'supabase_project', 'firebase_project'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_provider_check check (provider in ('cloudflare', 'neon', 'supabase', 'firebase'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_status_check check (status in ('requested', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_target_label_check check (char_length(target_label) between 1 and 120);--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '25 hours');--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_inputs_check check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 4096 and not (inputs ?| array['db_pass', 'dbPass', 'password', 'secret', 'token', 'apiKey', 'api_key', 'refresh_token']));--> statement-breakpoint
alter table ops.create_requests add constraint create_requests_result_check check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 2048 and not (result ?| array['db_pass', 'dbPass', 'password', 'secret', 'token', 'apiKey', 'api_key', 'refresh_token'])));--> statement-breakpoint
alter table ops.runners add constraint runners_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
alter table ops.runners add constraint runners_token_prefix_check check (token_prefix ~ '^wr_[A-Za-z0-9]{4}$');--> statement-breakpoint
alter table ops.runners add constraint runners_version_check check (version is null or (char_length(version) <= 40 and version ~ '^[0-9A-Za-z.+-]+$'));--> statement-breakpoint
alter table ops.runners add constraint runners_host_check check (host is null or (char_length(host) <= 253 and host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'));--> statement-breakpoint
alter table ops.runner_repo_settings add constraint runner_repo_settings_app_port_check check (app_port between 1 and 65535);--> statement-breakpoint
alter table ops.runner_repo_settings add constraint runner_repo_settings_env_check check (jsonb_typeof(env) = 'object' and octet_length(env::text) <= 12288);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_kind_check check (kind in ('preview', 'lockfile'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_status_check check (status in ('queued', 'claimed', 'running', 'ready', 'stopping', 'stopped', 'succeeded', 'failed'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_sha_check check (sha ~ '^[0-9a-f]{40}$');--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_ref_check check (char_length(ref) between 1 and 200);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_port_check check (port is null or port between 4100 and 4199);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_url_check check (url is null or (char_length(url) <= 300 and url ~ '^http://[a-z0-9.-]+:41[0-9]{2}$'));--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_logs_check check (logs is null or char_length(logs) <= 40000);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_error_check check (error is null or char_length(error) <= 300);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_attempts_check check (attempts between 0 and 10);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_params_check check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 16384);--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_archive_hash_check check (archive_token_hash is null or archive_token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
alter table ops.runner_jobs add constraint runner_jobs_lockfile_ref_check check (kind <> 'lockfile' or ref ~ '^watchpost/deps-[0-9a-f]{8}$');--> statement-breakpoint
create index events_recent on ops.events ((coalesce(last_at, at)) desc);--> statement-breakpoint
create unique index api_keys_active_name_key on ops.api_keys (name) where revoked_at is null;--> statement-breakpoint
create unique index ai_providers_default_one on ops.ai_providers ((true)) where is_default;--> statement-breakpoint
create unique index ai_providers_kind_one on ops.ai_providers (kind) where kind <> 'custom';--> statement-breakpoint
create unique index ai_agents_key_client_key on ops.ai_agents (coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid), client_name);--> statement-breakpoint
create unique index dev_notes_one_open_per_app on ops.dev_notes (app_id) where status in ('queued', 'running');--> statement-breakpoint
create unique index runners_one_active on ops.runners ((true)) where revoked_at is null;--> statement-breakpoint
insert into ops.alert_rules (key, severity, threshold, channels) values ('MonitorDown', 'critical', 3, '["telegram","email_digest"]'), ('CollectorStale', 'critical', 5, '["telegram","email_digest"]'), ('HighLatency', 'warning', 1500, '["telegram","email_digest"]'), ('DeploymentFailed', 'warning', null, '["telegram","email_digest"]'), ('DatabasePaused', 'warning', null, '["telegram","email_digest"]'), ('CertExpiringSoon', 'warning', 14, '["telegram","email_digest"]'), ('DomainExpiringSoon', 'warning', 30, '["telegram","email_digest"]'), ('StorageAlmostFull', 'warning', 80, '["telegram","email_digest"]'), ('NeonComputeHigh', 'warning', 80, '["telegram","email_digest"]'), ('FirestoreQuotaHigh', 'warning', 80, '["telegram","email_digest"]'), ('AutoPauseRisk', 'info', 4, '["email_digest"]'), ('DnsProxiedToVercel', 'info', null, '["email_digest"]'), ('CredentialExpiring', 'warning', 14, '["telegram","email_digest"]') on conflict (key) do nothing;--> statement-breakpoint
insert into ops.alert_rules (key, severity, threshold, channels) values ('VulnerableDependency', 'warning', null, '["telegram","email_digest"]') on conflict (key) do nothing;--> statement-breakpoint
insert into ops.alert_rules (key, severity, threshold, channels) values ('ComputeHigh', 'warning', 80, '["telegram","email_digest"]') on conflict (key) do nothing;--> statement-breakpoint
insert into ops.alert_rules (key, severity, threshold, channels) values ('DbQuotaHigh', 'warning', 80, '["telegram","email_digest"]') on conflict (key) do nothing;
