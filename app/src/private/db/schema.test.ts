import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NEWS_TOPICS, OFFICE_EVS, REPORT_LIMITS, REPORT_SOURCES, REPORT_VIAS } from "./office-types";
import { actionProposals, aiAgents, devNotes, aiNotes, aiProviders, aiQuestions, aiQuota, aiUsage, apiKeys, newsItems, officeEvents, officeReports } from "./schema";

const DRIZZLE = join(__dirname, "../../../drizzle");
const generated = readFileSync(join(DRIZZLE, "0016_ai_gateway.sql"), "utf8");
const lockdown = readFileSync(join(DRIZZLE, "0017_ai_gateway_lockdown.sql"), "utf8");
const TABLES = ["api_keys", "ai_providers", "ai_agents", "ai_usage", "ai_quota", "ai_notes", "ai_questions"];

describe("5c schema", () => {
  it("defines the seven tables in the ops schema", () => {
    const names = [apiKeys, aiProviders, aiAgents, aiUsage, aiQuota, aiNotes, aiQuestions].map((t) => getTableConfig(t));
    expect(names.map((c) => c.name)).toEqual(TABLES);
    expect(names.every((c) => c.schema === "ops")).toBe(true);
  });

  it.each(TABLES)("0016 creates ops.%s", (t) => {
    expect(generated).toContain(`CREATE TABLE "ops"."${t}"`);
  });

  it("indexes the key hash uniquely", () => {
    expect(generated).toMatch(/CREATE UNIQUE INDEX "api_keys_hash_key" ON "ops"\."api_keys"/);
  });

  it.each(TABLES)("0017 locks ops.%s down like every ops table", (t) => {
    expect(lockdown).toContain(`alter table ops.${t} enable row level security;`);
    expect(lockdown).toContain(`revoke all on ops.${t} from anon, authenticated;`);
    expect(lockdown).toContain(`create policy ops_app_all on ops.${t} for all to ops_app using (true) with check (true);`);
  });

  it("allows at most one default provider and checks values the ORM can't express", () => {
    expect(lockdown).toContain("create unique index ai_providers_default_one on ops.ai_providers ((true)) where is_default;");
    expect(lockdown).toContain("create unique index api_keys_active_name_key on ops.api_keys (name) where revoked_at is null;");
    expect(lockdown).toContain("api_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$')");
    expect(lockdown).toContain("ai_notes_body_check check (octet_length(body) <= 4096)");
  });

  it("keeps the AI notes' model and client, and bounds the questions (owner 07:35)", () => {
    const notes = getTableConfig(aiNotes).columns.map((c) => c.name);
    expect(notes).toEqual(expect.arrayContaining(["model", "client"]));
    expect(generated).toMatch(/CREATE INDEX "ai_questions_status_created_idx" ON "ops"\."ai_questions"/);
    expect(lockdown).toContain("ai_questions_context_kind_check check (context_kind in ('app', 'alert', 'general'))");
    expect(lockdown).toContain("ai_questions_status_check check (status in ('pending', 'answered', 'expired'))");
    expect(lockdown).toContain("ai_questions_question_check check (char_length(question) between 1 and 2000)");
    expect(lockdown).toContain("ai_questions_answer_check check (answer is null or char_length(answer) <= 8000)");
  });

  it("never grants anything to the browser roles", () => {
    expect(lockdown).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });
});

// Antigravity models (owner 13 Oct): a question can ask for one model, and Watchpost's own pings sit in the same inbox.
describe("0020_ai_question_models", () => {
  const sql = readFileSync(join(DRIZZLE, "0020_ai_question_models.sql"), "utf8");
  const statements = sql.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--"));

  it("is additive only: two nullable/defaulted columns and their checks, nothing dropped", () => {
    expect(sql).not.toMatch(/\bdrop\b|\brename\b|create table/i);
    expect(sql).toContain('ALTER TABLE "ops"."ai_questions" ADD COLUMN IF NOT EXISTS "requested_model" text;');
    expect(sql).toContain(`ALTER TABLE "ops"."ai_questions" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'ask' NOT NULL;`);
    expect(statements.every((s) => /^ALTER TABLE "ops"\."ai_questions" ADD (COLUMN IF NOT EXISTS|CONSTRAINT)/.test(s) || s === "--> statement-breakpoint")).toBe(true);
  });

  it("bounds the requested model and the purpose", () => {
    expect(sql).toContain(`ai_questions_requested_model_check" CHECK (requested_model is null or (char_length(requested_model) <= 120 and requested_model ~ '^[a-z0-9@/._-]+$'))`);
    expect(sql).toContain(`ai_questions_purpose_check" CHECK (purpose in ('ask', 'ping'))`);
  });

  it("puts both columns in the drizzle schema", () => {
    const cols = Object.fromEntries(getTableConfig(aiQuestions).columns.map((c) => [c.name, c]));
    expect(cols.requested_model.notNull).toBe(false);
    expect(cols.purpose.notNull).toBe(true);
    expect(cols.purpose.default).toBe("ask");
  });

  it("knows both columns in the 0020 snapshot", () => {
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0020_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: string }> }> };
    const cols = snap.tables["ops.ai_questions"].columns;
    expect(cols.requested_model).toMatchObject({ type: "text", notNull: false });
    expect(cols.purpose).toMatchObject({ type: "text", notNull: true, default: "'ask'" });
  });
});

// Usage & Analytics (owner 13 Oct): Antigravity's runs (MCP report_usage) are ai_usage rows of kind 'agent' with the
// cached and thinking token counts agy reports. Additive: two nullable columns; the kind check is replaced by a wider one.
describe("0021_ai_usage_agent", () => {
  const sql = readFileSync(join(DRIZZLE, "0021_ai_usage_agent.sql"), "utf8");
  const statements = sql.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--"));

  it("adds two nullable integer columns and nothing else structural", () => {
    expect(sql).not.toMatch(/drop table|drop column|\brename\b|create table/i);
    expect(sql).toContain('ALTER TABLE "ops"."ai_usage" ADD COLUMN IF NOT EXISTS "tokens_cached" integer;');
    expect(sql).toContain('ALTER TABLE "ops"."ai_usage" ADD COLUMN IF NOT EXISTS "tokens_thinking" integer;');
    expect(statements.every((s) => /^ALTER TABLE "ops"\."ai_usage" (ADD COLUMN IF NOT EXISTS|ADD CONSTRAINT|DROP CONSTRAINT IF EXISTS "ai_usage_kind_check")/.test(s) || s === "--> statement-breakpoint")).toBe(true);
  });

  it("replaces the kind check with one that also allows 'agent', and bounds the new counts", () => {
    expect(sql).toContain('ALTER TABLE "ops"."ai_usage" DROP CONSTRAINT IF EXISTS "ai_usage_kind_check";');
    expect(sql).toContain(`"ai_usage_kind_check" CHECK (kind in ('chat', 'models', 'mcp', 'status', 'me', 'console', 'agent'))`);
    expect(sql).toContain(`"ai_usage_tokens_cached_check" CHECK (tokens_cached is null or tokens_cached >= 0)`);
    expect(sql).toContain(`"ai_usage_tokens_thinking_check" CHECK (tokens_thinking is null or tokens_thinking >= 0)`);
    expect(sql.indexOf("DROP CONSTRAINT")).toBeLessThan(sql.indexOf('ADD CONSTRAINT "ai_usage_kind_check"'));
  });

  it("puts both columns in the drizzle schema", () => {
    const cols = Object.fromEntries(getTableConfig(aiUsage).columns.map((c) => [c.name, c]));
    expect(cols.tokens_cached.notNull).toBe(false);
    expect(cols.tokens_thinking.notNull).toBe(false);
    expect(cols.tokens_cached.getSQLType()).toBe("integer");
  });

  it("knows both columns in the 0021 snapshot", () => {
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0021_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }> };
    const cols = snap.tables["ops.ai_usage"].columns;
    expect(cols.tokens_cached).toMatchObject({ type: "integer", notNull: false });
    expect(cols.tokens_thinking).toMatchObject({ type: "integer", notNull: false });
  });
});

// Kantor Virtual (owner 14 Oct): the hook's compact events, locked down like every ops table, bounded like the API.
describe("0022_office_events", () => {
  const sql = readFileSync(join(DRIZZLE, "0022_office_events.sql"), "utf8");
  const lower = sql.toLowerCase();

  it("creates ops.office_events with an index on at, nothing dropped", () => {
    expect(sql).toContain('CREATE TABLE "ops"."office_events"');
    expect(sql).toContain('"id" bigserial PRIMARY KEY NOT NULL');
    expect(sql).toContain('"at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(sql).toContain('"spawn" jsonb');
    expect(sql).toContain('"key_id" uuid');
    expect(sql).toContain('CREATE INDEX "office_events_at_idx" ON "ops"."office_events" USING btree ("at")');
    expect(sql).not.toMatch(/drop table|drop column|\brename\b/i);
  });

  it("locks it down like 0017/0019: RLS, nothing for the browser roles, one ops_app policy", () => {
    expect(lower).toContain("alter table ops.office_events enable row level security;");
    expect(lower).toContain("revoke all on ops.office_events from anon, authenticated;");
    expect(lower).toContain("grant select, insert, delete on ops.office_events to ops_app;");
    expect(lower).toContain("grant usage, select on sequence ops.office_events_id_seq to ops_app;");
    expect(lower.match(/create policy/g)).toHaveLength(1);
    expect(lower).toContain("create policy ops_app_all on ops.office_events for all to ops_app using (true) with check (true);");
    expect(lower).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
  });

  it("checks ev against the hook's values (0024 adds 'patrol') and bounds every text column", () => {
    expect(sql).toContain("check (ev in ('prompt', 'wake', 'tool', 'tool_done', 'notify', 'stop', 'sub_start', 'sub_stop'))");
    for (const [col, max] of [["session", 16], ["project", 80], ["agent", 40], ["agent_type", 60], ["tool", 80], ["summary", 200], ["kind", 40]] as const) {
      const check = sql.split("\n").find((l) => l.includes(`office_events_${col}_check`)) ?? "";
      expect(check).toContain(`char_length(${col})`);
      expect(check).toMatch(new RegExp(`char_length\\(${col}\\)( between 1 and| <=) ${max}\\)`));
    }
  });

  it("matches the drizzle schema and the 0023 snapshot", () => {
    const cfg = getTableConfig(officeEvents);
    expect(cfg.schema).toBe("ops");
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(["agent", "agent_type", "at", "ev", "id", "key_id", "kind", "project", "session", "spawn", "summary", "tool", "usage"]);
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0023_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };
    expect(Object.keys(snap.tables["ops.office_events"].columns).sort()).toEqual(cfg.columns.map((c) => c.name).sort());
    expect(Object.keys(snap.tables["ops.office_events"].indexes)).toEqual(["office_events_at_idx"]);
  });
});

// Kantor Virtual token counts (owner 14 Oct): one nullable jsonb column, bounded like the API.
describe("0023_office_usage", () => {
  const sql = readFileSync(join(DRIZZLE, "0023_office_usage.sql"), "utf8");

  it("only adds a nullable usage column with a size check, nothing dropped", () => {
    expect(sql).toContain('ALTER TABLE "ops"."office_events" ADD COLUMN "usage" jsonb;');
    expect(sql).toContain("check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512))");
    expect(sql).not.toMatch(/drop table|drop column|\brename\b|not null/i);
  });

  // Kantor Virtual "Ask" (owner 14 Oct): office questions share the AI inbox as purpose 'office'.
  it("widens ai_questions_purpose_check to ('ask', 'ping', 'office'), dropping only that one constraint", () => {
    expect(sql).toContain("alter table ops.ai_questions drop constraint if exists ai_questions_purpose_check;--> statement-breakpoint");
    expect(sql).toContain("alter table ops.ai_questions add constraint ai_questions_purpose_check check (purpose in ('ask', 'ping', 'office'));");
    expect(sql.match(/drop constraint/gi)).toHaveLength(1);
    expect(sql.indexOf("drop constraint if exists ai_questions_purpose_check")).toBeLessThan(sql.indexOf("add constraint ai_questions_purpose_check"));
  });

  it("separates every statement with a breakpoint", () => {
    const statements = sql.split("--> statement-breakpoint").map((s) => s.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--")).join(" ").trim());
    expect(statements).toHaveLength(4);
    expect(statements.every((s) => s.endsWith(";") && s.split(";").length === 2)).toBe(true);
  });
});


// Kantor Virtual "Patroli" + report inbox (owner 14 Oct): patrol rows are office events (ev 'patrol'), full reports go
// to ops.office_reports, locked down and bounded like 0022.
describe("0024_office_patrol", () => {
  const sql = readFileSync(join(DRIZZLE, "0024_office_patrol.sql"), "utf8");
  const lower = sql.toLowerCase();
  const statements = sql.split("--> statement-breakpoint").map((s) => s.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--")).join(" ").trim());

  it("creates ops.office_reports with an index on at; nothing dropped but the one ev check", () => {
    expect(sql).toContain('CREATE TABLE "ops"."office_reports"');
    expect(sql).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL');
    expect(sql).toContain('"at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(sql).toContain('"read_at" timestamp with time zone');
    expect(sql).toContain('CREATE INDEX "office_reports_at_idx" ON "ops"."office_reports" USING btree ("at")');
    expect(sql).not.toMatch(/drop table|drop column|\brename\b/i);
    expect(sql.match(/drop constraint/gi)).toHaveLength(1);
    expect(statements.every((s) => s.endsWith(";") || s.endsWith(")"))).toBe(true);
  });

  it("widens office_events_ev_check to the API's values, 'patrol' included (drop before add)", () => {
    expect(OFFICE_EVS).toContain("patrol");
    const drop = "alter table ops.office_events drop constraint if exists office_events_ev_check;";
    const add = `alter table ops.office_events add constraint office_events_ev_check check (ev in (${OFFICE_EVS.map((v) => `'${v}'`).join(", ")}));`;
    expect(statements).toContain(drop);
    expect(statements).toContain(add);
    expect(statements.indexOf(drop)).toBeLessThan(statements.indexOf(add));
  });

  it("locks office_reports down like 0022: RLS, nothing for the browser roles, one ops_app policy", () => {
    expect(lower).toContain("alter table ops.office_reports enable row level security;");
    expect(lower).toContain("revoke all on ops.office_reports from anon, authenticated;");
    expect(lower).toContain("grant select, insert, update, delete on ops.office_reports to ops_app;");
    expect(lower.match(/create policy/g)).toHaveLength(1);
    expect(lower).toContain("create policy ops_app_all on ops.office_reports for all to ops_app using (true) with check (true);");
    expect(lower).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
  });

  it("checks source, via and every bound against the API's limits", () => {
    const line = (name: string) => sql.split("\n").find((l) => l.includes(`office_reports_${name}_check`)) ?? "";
    // 0024's own values; 0025 widens the check to every REPORT_SOURCES value ('meeting').
    expect(line("source")).toContain("check (source in ('patrol', 'manager'))");
    expect(line("via")).toContain(`via in (${REPORT_VIAS.map((v) => `'${v}'`).join(", ")})`);
    expect(line("via")).toContain(`char_length(via) <= ${REPORT_LIMITS.via}`);
    expect(line("title")).toContain(`char_length(title) between 1 and ${REPORT_LIMITS.title}`);
    expect(line("body")).toContain(`char_length(body) between 1 and ${REPORT_LIMITS.body}`);
    expect(line("model")).toContain(`char_length(model) <= ${REPORT_LIMITS.model}`);
    expect(line("rooms")).toContain(`jsonb_typeof(rooms) = 'array' and octet_length(rooms::text) <= ${REPORT_LIMITS.roomsBytes}`);
    expect(line("usage")).toContain("jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 512");
  });

  it("matches the drizzle schema and the 0024 snapshot (chained after 0023, office_events unchanged)", () => {
    type Snap = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };
    const read = (f: string) => JSON.parse(readFileSync(join(DRIZZLE, "meta", f), "utf8")) as Snap;
    const prev = read("0023_snapshot.json");
    const snap = read("0024_snapshot.json");
    expect(snap.prevId).toBe(prev.id);
    expect(snap.tables["ops.office_events"]).toEqual(prev.tables["ops.office_events"]);
    const cfg = getTableConfig(officeReports);
    expect(cfg.schema).toBe("ops");
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(["at", "body", "id", "key_id", "model", "read_at", "rooms", "source", "title", "usage", "via"]);
    expect(Object.keys(snap.tables["ops.office_reports"].columns).sort()).toEqual(cfg.columns.map((c) => c.name).sort());
    expect(Object.keys(snap.tables["ops.office_reports"].indexes)).toEqual(["office_reports_at_idx"]);
  });
});

// Kantor Virtual morning meeting (owner 15 Oct): the inbox also takes source 'meeting'; nothing else changes.
describe("0025_office_meeting", () => {
  const sql = readFileSync(join(DRIZZLE, "0025_office_meeting.sql"), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--")).join(" ").trim());

  it("widens office_reports_source_check to the API's values, 'meeting' included (drop before add), and nothing else", () => {
    // 0025's own values; Stage 10's 0040 widens it again (the teams).
    expect(REPORT_SOURCES.slice(0, 3)).toEqual(["patrol", "manager", "meeting"]);
    const drop = "alter table ops.office_reports drop constraint if exists office_reports_source_check;";
    const add = `alter table ops.office_reports add constraint office_reports_source_check check (source in (${REPORT_SOURCES.slice(0, 3).map((v) => `'${v}'`).join(", ")}));`;
    expect(statements).toEqual([drop, add]);
    expect(sql).not.toMatch(/drop table|drop column|\brename\b|create table|grant|policy/i);
  });

  it("is in the journal after 0024 and its snapshot chains to 0024 with the same tables (a check is not in the snapshot)", () => {
    type Snap = { id: string; prevId: string; tables: Record<string, unknown> };
    const read = (f: string) => JSON.parse(readFileSync(join(DRIZZLE, "meta", f), "utf8")) as Snap;
    const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    // Stage 7 added 0026–0029 after it, so it is found by its index rather than as the last entry.
    expect(journal.entries.find((e) => e.idx === 25)).toMatchObject({ idx: 25, tag: "0025_office_meeting" });
    const prev = read("0024_snapshot.json");
    const snap = read("0025_snapshot.json");
    expect(snap.prevId).toBe(prev.id);
    expect(snap.id).not.toBe(prev.id);
    expect(snap.tables).toEqual(prev.tables);
  });
});

// Stage 9 slice 1 (owner 15 Oct): action proposals, locked down like every ops table, one open proposal per alert+action.
describe("0030_office_proposals / 0031 lock-down", () => {
  const sql = readFileSync(join(DRIZZLE, "0030_office_proposals.sql"), "utf8");
  const lock = readFileSync(join(DRIZZLE, "0031_office_proposals_lockdown.sql"), "utf8").toLowerCase();

  it("creates ops.action_proposals with the partial unique index, nothing dropped", () => {
    expect(sql).toContain('CREATE TABLE "ops"."action_proposals"');
    expect(sql).toContain(`CREATE UNIQUE INDEX "action_proposals_open_alert_action" ON "ops"."action_proposals" USING btree ("alert_id","action") WHERE status in ('pending', 'approved', 'running')`);
    expect(sql).not.toMatch(/drop table|drop column|\brename\b/i);
    const cols = getTableConfig(actionProposals).columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["alert_id", "rule_key", "resource_kind", "resource_id", "target_ref", "decided_by", "claimed_at", "expires_at", "status", "auto", "result"]));
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0031_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, unknown> }> };
    expect(Object.keys(snap.tables["ops.action_proposals"].columns).sort()).toEqual([...cols].sort());
  });

  it("locks it down: RLS, nothing for the browser roles, one ops_app policy, the contract's values", () => {
    expect(lock).toContain("alter table ops.action_proposals enable row level security;");
    expect(lock).toContain("revoke all on ops.action_proposals from anon, authenticated;");
    expect(lock).toContain("create policy ops_app_all on ops.action_proposals for all to ops_app using (true) with check (true);");
    expect(lock.match(/create policy/g)).toHaveLength(1);
    expect(lock).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
    expect(lock).toContain("check (status in ('pending', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'))");
    expect(lock).toContain("check (action in ('recheck', 'neon_wake', 'supabase_keepalive', 'supabase_restore', 'vercel_redeploy', 'vercel_rollback'))");
    expect(lock).toContain("check (not auto or risk = 'safe')");
    // 0046 (auto-rollback, owner 16 Oct) widens it for vercel_rollback only, replacing just this constraint.
    const wider = readFileSync(join(DRIZZLE, "0046_auto_rollback.sql"), "utf8").toLowerCase();
    expect(wider).toContain("alter table ops.action_proposals drop constraint if exists action_proposals_auto_check;--> statement-breakpoint");
    expect(wider).toContain("add constraint action_proposals_auto_check check (not auto or risk = 'safe' or action = 'vercel_rollback');");
    expect(wider.indexOf("drop constraint")).toBeLessThan(wider.indexOf("add constraint"));
    expect(wider.match(/drop /g)).toHaveLength(1);
    expect(wider).not.toMatch(/drop table|drop column|create table/);
    // 0047 (automatic security fixes) adds github_bump_pr, and only that.
    const sec = readFileSync(join(DRIZZLE, "0047_dependency_prs.sql"), "utf8").toLowerCase();
    expect(sec).toContain("add constraint action_proposals_auto_check check (not auto or risk = 'safe' or action in ('vercel_rollback', 'github_bump_pr'));");
    expect(sec.indexOf("drop constraint if exists action_proposals_auto_check")).toBeLessThan(sec.indexOf("add constraint action_proposals_auto_check"));
    expect(sec.match(/drop /g)).toHaveLength(1);
    expect(sec).not.toMatch(/drop table|drop column/);
    expect(sec).toContain('create table "ops"."dependency_prs"');
    expect(sec).toContain("alter table ops.dependency_prs enable row level security;");
    expect(sec).toContain("revoke all on ops.dependency_prs from anon, authenticated;");
    expect(sec).toContain("create policy ops_app_all on ops.dependency_prs for all to ops_app using (true) with check (true);");
    expect(sec).toContain("check (branch ~ '^watchpost/deps-[0-9a-f]{8}$')");
    expect(sec).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
    expect(lock).toContain("check (char_length(reason) between 1 and 200)");
  });
});

// Stage 9 slice 3 (owner 16 Oct): the Dev officer's notes, locked down like every ops table, one open note per app and
// one note per proposal.
describe("0032_dev_notes / 0033 lock-down", () => {
  const sql = readFileSync(join(DRIZZLE, "0032_dev_notes.sql"), "utf8");
  const lock = readFileSync(join(DRIZZLE, "0033_dev_notes_lockdown.sql"), "utf8").toLowerCase();

  it("creates ops.dev_notes with the one-note-per-proposal index, nothing dropped", () => {
    expect(sql).toContain('CREATE TABLE "ops"."dev_notes"');
    expect(sql).toContain('CREATE UNIQUE INDEX "dev_notes_proposal_one" ON "ops"."dev_notes" USING btree ("proposal_id") WHERE proposal_id is not null');
    expect(sql).not.toMatch(/drop table|drop column|\brename\b/i);
    const cols = getTableConfig(devNotes).columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["app_id", "proposal_id", "trigger", "status", "question", "summary", "cause", "files", "patch", "confidence", "requested_by"]));
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0033_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, unknown> }> };
    expect(Object.keys(snap.tables["ops.dev_notes"].columns).sort()).toEqual([...cols].sort());
  });

  it("locks it down and checks the contract's values and limits", () => {
    expect(lock).toContain("alter table ops.dev_notes enable row level security;");
    expect(lock).toContain("revoke all on ops.dev_notes from anon, authenticated;");
    expect(lock).toContain("create policy ops_app_all on ops.dev_notes for all to ops_app using (true) with check (true);");
    expect(lock).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
    expect(lock).toContain("create unique index dev_notes_one_open_per_app on ops.dev_notes (app_id) where status in ('queued', 'running');");
    expect(lock).toContain("check (status in ('queued', 'running', 'done', 'failed', 'skipped'))");
    expect(lock).toContain("check (patch is null or char_length(patch) <= 4000)");
    expect(lock).toContain("check (summary is null or char_length(summary) <= 400)");
  });
});

// Stage 10 (owner 16 Oct): the teams' reports (source = the team) and Berita Dunia's headlines.
describe("0040_office_teams / 0041 lock-down", () => {
  const sql = readFileSync(join(DRIZZLE, "0040_office_teams.sql"), "utf8");
  const lock = readFileSync(join(DRIZZLE, "0041_office_teams_lockdown.sql"), "utf8").toLowerCase();

  it("creates ops.news_items with the url+day unique index and widens the reports' source check to every REPORT_SOURCES value", () => {
    expect(sql).toContain('CREATE TABLE "ops"."news_items"');
    expect(sql).toContain('CREATE UNIQUE INDEX "news_items_url_day" ON "ops"."news_items" USING btree ("url","day")');
    expect(sql).not.toMatch(/drop table|drop column|rename/i);
    expect(REPORT_SOURCES).toEqual(["patrol", "manager", "meeting", "news", "research", "analytics", "content"]);
    const drop = sql.indexOf("drop constraint if exists office_reports_source_check");
    const add = sql.indexOf(`check (source in (${REPORT_SOURCES.map((v) => `'${v}'`).join(", ")}))`);
    expect(drop).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(drop);
    const cols = getTableConfig(newsItems).columns.map((c) => c.name).sort();
    expect(cols).toEqual(["day", "fetched_at", "id", "published_at", "source", "title", "topic", "url"]);
    const snap = JSON.parse(readFileSync(join(DRIZZLE, "meta", "0041_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, unknown> }> };
    expect(Object.keys(snap.tables["ops.news_items"].columns).sort()).toEqual(cols);
  });

  it("locks news_items down like every ops table and checks topic, title, url and source", () => {
    expect(lock).toContain("alter table ops.news_items enable row level security;");
    expect(lock).toContain("revoke all on ops.news_items from anon, authenticated;");
    expect(lock).toContain("grant select, insert, update, delete on ops.news_items to ops_app;");
    expect(lock.match(/create policy/g)).toHaveLength(1);
    expect(lock).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
    expect(lock).toContain(`check (topic in (${NEWS_TOPICS.map((t) => `'${t}'`).join(", ")}))`);
    expect(lock).toContain("char_length(title) between 1 and 200");
    expect(lock).toContain("char_length(url) between 1 and 1000");
  });
});
