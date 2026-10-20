import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../drizzle", import.meta.url));
// Comment lines are dropped so a commented-out statement can't satisfy a check.
const allSql = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

describe("migrations", () => {
  it("adds the owner's own pause to ops.monitors, off by default", () => {
    expect(allSql()).toContain('ALTER TABLE "ops"."monitors" ADD COLUMN "owner_paused" boolean DEFAULT false NOT NULL');
  });

  it("adds ops.app_security, one row per app, removed with its app, status limited to the four values", () => {
    const sql = allSql();
    expect(sql).toContain('CREATE TABLE "ops"."app_security"');
    expect(sql).toContain(`"findings" jsonb DEFAULT '[]'::jsonb NOT NULL`);
    expect(sql).toContain('FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade');
    expect(sql.toLowerCase()).toContain("check (status in ('ok', 'vulnerable', 'unknown', 'error'))");
  });

  it("adds ops.links: topology edges that vanish with either resource, one database per app", () => {
    const sql = allSql();
    expect(sql).toContain('CREATE TABLE "ops"."links"');
    expect(sql).toContain(`CREATE TYPE "ops"."link_kind" AS ENUM('serves', 'uses_db')`);
    expect(sql).toContain('FOREIGN KEY ("from_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade');
    expect(sql).toContain('FOREIGN KEY ("to_resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "links_one_db_per_app" ON "ops"\."links" USING btree \("from_resource_id"\) WHERE kind = 'uses_db'/);
  });

  it("adds the stage 5 tables", () => {
    const s = allSql();
    for (const t of ["alert_rules", "alerts", "channels", "stored_logs", "provider_status"]) expect(s).toContain(`CREATE TABLE "ops"."${t}"`);
    expect(s).toContain('ALTER TABLE "ops"."events" ADD COLUMN "reason" text');
    expect(s).toContain('ALTER TABLE "ops"."events" ADD COLUMN "count" integer DEFAULT 1 NOT NULL');
    expect(s).toContain('ALTER TABLE "ops"."events" ADD COLUMN "last_at" timestamp with time zone');
  });

  it("keeps one open alert per rule and subject", () => {
    expect(allSql()).toContain('CREATE UNIQUE INDEX "alerts_open_rule_subject" ON "ops"."alerts" USING btree ("rule_key","subject") WHERE resolved_at is null');
  });

  it("seeds the 13 rules from spec §10 without overwriting edits", () => {
    const s = allSql();
    for (const k of ["MonitorDown", "CollectorStale", "HighLatency", "DeploymentFailed", "DatabasePaused", "CertExpiringSoon", "DomainExpiringSoon",
      "StorageAlmostFull", "NeonComputeHigh", "FirestoreQuotaHigh", "AutoPauseRisk", "DnsProxiedToVercel", "CredentialExpiring"]) {
      expect(s).toContain(`('${k}',`);
    }
    expect(s.toLowerCase()).toContain("on conflict (key) do nothing");
  });

  it("limits stored log levels and pending notices to known values", () => {
    const s = allSql().toLowerCase();
    expect(s).toContain("check (level in ('warning', 'error', 'fatal'))");
    expect(s).toContain("check (pending is null or pending in ('open', 'repeat', 'resolve'))");
  });

  it("keep every console table and type out of the public schema", () => {
    const sql = allSql();
    expect(sql).toMatch(/CREATE SCHEMA "ops"/);
    expect(sql).toMatch(/CREATE TABLE "ops"\./);
    expect(sql).not.toMatch(/CREATE (TABLE|TYPE) "(?!ops")/);
  });

  it.each([
    "members",
    "invites",
    "accounts",
    "settings",
    "rate_limits",
    "resources",
    "snapshots",
    "monitors",
    "checks",
    "rollups_hourly",
    "deployments",
    "events",
    "collector_runs",
    "app_security",
    "links",
    "backups",
    "github_repos",
    "app_repos",
  ])("enable RLS on ops.%s", (table) => {
    expect(allSql()).toMatch(new RegExp(`alter table ops\\.${table} enable row level security`, "i"));
  });

  it("gives the app role a policy and grants on ops.rate_limits", () => {
    const sql = allSql().toLowerCase();
    expect(sql).toContain("create policy ops_app_all on ops.rate_limits for all to ops_app using (true) with check (true)");
    expect(sql).toContain("grant select, insert, update, delete on ops.rate_limits to ops_app");
  });

  it("adds the maintenance state and the 5b columns and tables", () => {
    const s = allSql();
    expect(s).toContain(`ALTER TYPE "ops"."state" ADD VALUE 'maint'`);
    for (const c of ["kind", "name", "body_contains", "json_path", "json_equals", "last_error", "token_hash", "period_s", "grace_s", "last_ping_at", "last_ping_kind"]) {
      expect(s).toContain(`ALTER TABLE "ops"."monitors" ADD COLUMN "${c}"`);
    }
    expect(s).toContain('ALTER TABLE "ops"."checks" ADD COLUMN "in_maintenance" boolean DEFAULT false NOT NULL');
    expect(s).toContain('ALTER TABLE "ops"."rollups_hourly" ADD COLUMN "maintenance" integer DEFAULT 0 NOT NULL');
    for (const t of ["maintenance_windows", "recommendation_dismissals", "status_pages", "status_page_monitors"]) expect(s).toContain(`CREATE TABLE "ops"."${t}"`);
    expect(s).toContain('CREATE UNIQUE INDEX "monitors_token_hash" ON "ops"."monitors" USING btree ("token_hash") WHERE token_hash is not null');
  });

  it("checks the 5b enums in SQL", () => {
    const s = allSql().toLowerCase();
    expect(s).toContain("check (kind in ('http', 'heartbeat'))");
    expect(s).toContain("check (scope in ('all', 'app', 'monitor'))");
    expect(s).toContain("check (last_ping_kind is null or last_ping_kind in ('ok', 'fail', 'start'))");
  });

  it.each(["resources", "snapshots", "monitors", "checks", "rollups_hourly", "deployments", "events", "collector_runs", "app_security", "links", "alert_rules", "alerts", "channels", "stored_logs", "provider_status", "maintenance_windows", "recommendation_dismissals", "status_pages", "status_page_monitors", "backups", "github_repos", "app_repos"])(
    "gives the app role a policy and grants on ops.%s",
    (table) => {
      const sql = allSql().toLowerCase();
      expect(sql).toContain(`create policy ops_app_all on ops.${table} for all to ops_app using (true) with check (true)`);
      expect(sql).toContain(`grant select, insert, update, delete on ops.${table} to ops_app`);
      expect(sql).toContain(`revoke all on ops.${table} from anon, authenticated`);
    },
  );

  it("adds ops.keep_active (stage 6 A8): one row per Supabase project, off by default, removed with its resource", () => {
    const s = allSql();
    expect(s).toContain('CREATE TABLE "ops"."keep_active"');
    expect(s).toContain('"resource_id" uuid PRIMARY KEY NOT NULL');
    expect(s).toContain('"keep" boolean DEFAULT false NOT NULL');
    expect(s).toContain('"auto_restore" boolean DEFAULT false NOT NULL');
    expect(s).toContain('"last_keep_alive_at" timestamp with time zone');
    expect(s).toContain('"last_auto_restore_at" timestamp with time zone');
    expect(s).toContain('ALTER TABLE "ops"."keep_active" ADD CONSTRAINT "keep_active_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "ops"."resources"("id") ON DELETE cascade');
  });

  it("locks ops.keep_active down like every ops table (0019)", () => {
    const s = readFileSync(join(dir, "0019_keep_active_lockdown.sql"), "utf8").toLowerCase();
    expect(s).toContain("alter table ops.keep_active enable row level security");
    expect(s).toContain("revoke all on ops.keep_active from anon, authenticated");
    expect(s).toContain("grant select, insert, update, delete on ops.keep_active to ops_app");
    expect(s).toContain("create policy ops_app_all on ops.keep_active for all to ops_app using (true) with check (true)");
    expect(s).not.toMatch(/to (anon|authenticated|public)/);
  });

  it("adds ops.backups (stage 7): one row per month, the Drive ids kept, status and month checked in SQL", () => {
    const s = allSql();
    expect(s).toContain('CREATE TABLE "ops"."backups"');
    expect(s).toContain('CONSTRAINT "backups_month_unique" UNIQUE("month")');
    for (const c of ["drive_folder_id", "sheet_file_id", "csv_file_id", "size_bytes", "trashed_at"]) expect(s).toContain(`"${c}"`);
    expect(s.toLowerCase()).toContain("check (status in ('ok', 'partial', 'error'))");
    expect(s).toContain("check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')");
  });

  it("adds the github provider, ops.github_repos and ops.app_repos (stage 7), removed with their account or app", () => {
    const s = allSql();
    expect(s).toContain(`ALTER TYPE "ops"."provider" ADD VALUE 'github'`);
    expect(s).toContain('ALTER TABLE "ops"."github_repos" ADD CONSTRAINT "github_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE cascade');
    expect(s).toContain('ALTER TABLE "ops"."app_repos" ADD CONSTRAINT "app_repos_app_id_resources_id_fk" FOREIGN KEY ("app_id") REFERENCES "ops"."resources"("id") ON DELETE cascade');
    expect(s).toContain('FOREIGN KEY ("repo_id") REFERENCES "ops"."github_repos"("id") ON DELETE cascade');
    expect(s).toContain('CREATE UNIQUE INDEX "github_repos_account_external" ON "ops"."github_repos" USING btree ("account_id","external_id")');
    expect(s.toLowerCase()).toContain("check (source in ('vercel', 'manual'))");
  });

  it("adds the new enum value in its own file, where nothing uses it yet", () => {
    const file = readFileSync(join(dir, "0028_github.sql"), "utf8");
    expect(file.match(/'github'/g)).toHaveLength(1);
  });

  it.each([["0027_backups_lockdown.sql", ["backups"]], ["0029_github_lockdown.sql", ["github_repos", "app_repos"]]] as const)(
    "%s locks its tables down and grants nothing to browser roles",
    (file, tables) => {
      const s = readFileSync(join(dir, file), "utf8").toLowerCase();
      for (const t of tables) {
        expect(s).toContain(`alter table ops.${t} enable row level security`);
        expect(s).toContain(`revoke all on ops.${t} from anon, authenticated`);
        expect(s).toContain(`create policy ops_app_all on ops.${t} for all to ops_app using (true) with check (true)`);
      }
      expect(s).not.toMatch(/to (anon|authenticated|public)/);
    },
  );

  it.each([
    "revoke all on schema ops from anon, authenticated",
    "revoke all on all tables in schema ops from anon, authenticated",
    "revoke all on all sequences in schema ops from anon, authenticated",
    "revoke all on all functions in schema ops from anon, authenticated",
    "alter default privileges in schema ops revoke all on tables from anon, authenticated",
    "alter default privileges in schema ops revoke all on sequences from anon, authenticated",
    "alter default privileges in schema ops revoke all on functions from anon, authenticated",
  ])("lock down browser roles: %s", (statement) => {
    expect(allSql().toLowerCase()).toContain(statement);
  });
});

// I8 (stage 5 review): 0009 (stage 3) is already applied, so 0011 and 0012 must follow it in the journal and in the
// snapshot chain. A broken chain makes the next `drizzle-kit generate` re-create tables that exist.
describe("migration journal and snapshot chain", () => {
  type Snap = { id: string; prevId: string; tables: Record<string, unknown> };
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const snaps = readdirSync(join(dir, "meta")).filter((f) => f.endsWith("_snapshot.json")).sort()
    .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(dir, "meta", f), "utf8")) as Snap) }));

  it("lists every migration file once, in order, with increasing times", () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.map((t) => t.slice(0, 4))).toEqual(["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035", "0036", "0037", "0038", "0039", "0040", "0041", "0042", "0043", "0046", "0047", "0048", "0049", "0051", "0052", "0053", "0054", "0055"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()).toEqual(tags.map((t) => `${t}.sql`));
    journal.entries.slice(1).forEach((e, i) => expect(e.when).toBeGreaterThan(journal.entries[i].when));
  });
  it("chains every snapshot to the one before it, and the last one has the links, stage 5 and 5b tables", () => {
    expect(snaps.map((s) => s.file.slice(0, 4))).toEqual(journal.entries.map((e) => e.tag.slice(0, 4)));
    snaps.slice(1).forEach((s, i) => expect(s.prevId, s.file).toBe(snaps[i].id));
    const last = snaps[snaps.length - 1];
    for (const t of ["links", "alert_rules", "alerts", "channels", "stored_logs", "provider_status", "maintenance_windows", "recommendation_dismissals", "status_pages", "status_page_monitors", "keep_active", "backups", "github_repos", "app_repos"]) expect(Object.keys(last.tables)).toContain(`ops.${t}`);
  });
  it("creates links only once (0009), never again in 0011", () => {
    expect(allSql().match(/CREATE TABLE "ops"\."links"/g)).toHaveLength(1);
  });
});

// Perf P4: the hot reads' indexes, additive and safe to run twice; the snapshot knows them, so the next generate
// doesn't drop or repeat them.
describe("0013_perf_indexes", () => {
  const file = readFileSync(join(dir, "0013_perf_indexes.sql"), "utf8");
  const statements = file.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("--"));
  it("only creates indexes, each IF NOT EXISTS and never CONCURRENTLY", () => {
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s).toMatch(/^CREATE INDEX IF NOT EXISTS "\w+" ON "ops"\./);
    expect(statements.join("\n")).not.toMatch(/concurrently|drop|alter/i);
  });
  it("indexes checks and deployments by time and events by their newest occurrence", () => {
    expect(file).toContain('"checks_at" ON "ops"."checks" USING btree ("at")');
    expect(file).toContain('"deployments_created" ON "ops"."deployments" USING btree ("created_at_provider")');
    expect(file).toContain('"events_latest" ON "ops"."events" USING btree (coalesce("last_at", "at"))');
  });
  it("is in the last snapshot", () => {
    const last = JSON.parse(readFileSync(join(dir, "meta", "0013_snapshot.json"), "utf8")) as { tables: Record<string, { indexes: Record<string, unknown> }> };
    expect(Object.keys(last.tables["ops.checks"].indexes)).toContain("checks_at");
    expect(Object.keys(last.tables["ops.deployments"].indexes)).toContain("deployments_created");
    expect(Object.keys(last.tables["ops.events"].indexes)).toContain("events_latest");
  });
});
