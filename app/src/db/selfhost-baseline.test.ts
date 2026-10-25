import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../drizzle.selfhost.config";
import base from "../../drizzle.config";
import { rowsOf } from "./rows";
import { selfhostMigrationsFolder } from "./pglite";

// The schema files drizzle-kit reads, with the private glob ("<dir>/!(*.test).ts") expanded the same way.
function schemaFiles(): string[] {
  const entries = Array.isArray(base.schema) ? base.schema : [base.schema ?? ""];
  return entries.flatMap((entry) => {
    const glob = entry.match(/^(.*)\/!\(\*\.test\)\.ts$/);
    if (!glob) return [resolve(entry)];
    const dir = resolve(glob[1]);
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(dir, f));
    } catch {
      return []; // the private folder is absent in the open-source tree
    }
  });
}

async function schemaTables(): Promise<PgTable[]> {
  const tables = new Set<PgTable>();
  for (const file of schemaFiles()) {
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ pathToFileURL(file).href);
    for (const value of Object.values(mod)) if (is(value, PgTable)) tables.add(value);
  }
  return [...tables];
}

// Names of the hand-written indexes and CHECK constraints in the cloud history (app/drizzle), in their final state: a
// check dropped later and not re-added is left out. The self-host copies live in drizzle-selfhost/0001_cloud_parity.sql.
function cloudNames(): { indexes: Set<string>; checks: Set<string> } {
  const dir = resolve("drizzle");
  const indexes = new Set<string>();
  const checks = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(dir, file), "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const raw of text.split(";")) {
      const st = raw.trim().replace(/\s+/g, " ");
      let m: RegExpMatchArray | null;
      if ((m = st.match(/^create (?:unique )?index (?:if not exists )?"?(\w+)"?/i))) indexes.add(m[1]);
      else if ((m = st.match(/add constraint "?(\w+)"? check\b/i))) checks.add(m[1]);
      else if ((m = st.match(/drop constraint (?:if exists )?"?(\w+)"?/i))) checks.delete(m[1]);
    }
  }
  return { indexes, checks };
}

const baselineSql = () =>
  readdirSync(selfhostMigrationsFolder())
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(selfhostMigrationsFolder(), f), "utf8"))
    .join("\n");

// Schema introspection over PGlite takes a few seconds alone and more under full-suite load: 30 s per test.
describe("self-host migration baseline", { timeout: 30_000 }, () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = await PGlite.create();
    db = drizzle({ client });
    await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it("is generated from the same schema files and schema filter as the cloud config", () => {
    expect(config.schema).toEqual(base.schema);
    expect(config.schemaFilter).toEqual(base.schemaFilter);
    expect(config.out).toBe("./drizzle-selfhost");
  });

  it("creates every Drizzle table in ops with the same columns (fails when the baseline is stale: npm run db:generate:selfhost)", async () => {
    const tables = await schemaTables();
    expect(tables.length).toBeGreaterThan(40);
    const res = await db.execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'ops'`);
    const actual = new Map<string, Set<string>>();
    for (const r of rowsOf<{ table_name: string; column_name: string }>(res)) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }
    for (const table of tables) {
      const cfg = getTableConfig(table);
      expect(cfg.schema, cfg.name).toBe("ops");
      expect([...(actual.get(cfg.name) ?? [])].sort(), `ops.${cfg.name}`).toEqual(cfg.columns.map((c) => c.name).sort());
    }
  });

  it("has every index and CHECK constraint the cloud migrations define (fails when app/drizzle gains one)", async () => {
    const cloud = cloudNames();
    expect(cloud.indexes.size).toBeGreaterThan(50);
    expect(cloud.checks.size).toBeGreaterThan(100);
    const indexes = new Set(
      rowsOf<{ indexname: string }>(await db.execute(sql`select indexname from pg_indexes where schemaname = 'ops'`)).map((r) => r.indexname),
    );
    expect([...cloud.indexes].filter((n) => !indexes.has(n))).toEqual([]);
    const checks = rowsOf<{ conname: string }>(
      await db.execute(sql`select c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'ops' and c.contype = 'c'`),
    ).map((r) => r.conname);
    expect(checks.sort()).toEqual([...cloud.checks].sort());
  });

  it("seeds the alert rules the cloud migrations insert", async () => {
    const keys = rowsOf<{ key: string }>(await db.execute(sql`select key from ops.alert_rules`)).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["MonitorDown", "CollectorStale", "HighLatency", "DeploymentFailed", "VulnerableDependency", "ComputeHigh", "DbQuotaHigh", "FrameworkVulnerable", "MonitorDomainMoved"]));
  });

  // Review T1 minor 10: FrameworkVulnerable takes the owner's channels of VulnerableDependency (else the default), in both
  // editions' seeds; an existing FrameworkVulnerable row is never changed.
  it("seeds FrameworkVulnerable with VulnerableDependency's channels, else the default (cloud 0056 and self-host 0005)", async () => {
    const channels = async (key: string) =>
      rowsOf<{ channels: unknown }>(await db.execute(sql`select channels from ops.alert_rules where key = ${key}`)).map((r) => r.channels)[0];
    const seeds = [readFileSync(resolve("drizzle/0056_framework_vulnerable_rule.sql"), "utf8"), readFileSync(join(selfhostMigrationsFolder(), "0005_framework_vulnerable_rule.sql"), "utf8")];
    const before = await channels("VulnerableDependency");
    try {
      for (const seed of seeds) {
        await db.execute(sql`delete from ops.alert_rules where key = 'FrameworkVulnerable'`);
        await db.execute(sql`update ops.alert_rules set channels = '["discord"]'::jsonb where key = 'VulnerableDependency'`);
        await db.execute(sql.raw(seed));
        expect(await channels("FrameworkVulnerable")).toEqual(["discord"]);
        // ON CONFLICT DO NOTHING: an owner's edit stays
        await db.execute(sql`update ops.alert_rules set channels = '["email_digest"]'::jsonb where key = 'FrameworkVulnerable'`);
        await db.execute(sql.raw(seed));
        expect(await channels("FrameworkVulnerable")).toEqual(["email_digest"]);
        // no VulnerableDependency row: the default channels
        const vd = rowsOf<Record<string, unknown>>(await db.execute(sql`delete from ops.alert_rules where key = 'VulnerableDependency' returning key, severity, threshold, channels, enabled`))[0];
        await db.execute(sql`delete from ops.alert_rules where key = 'FrameworkVulnerable'`);
        await db.execute(sql.raw(seed));
        expect(await channels("FrameworkVulnerable")).toEqual(["telegram", "email_digest"]);
        await db.execute(sql`insert into ops.alert_rules (key, severity, threshold, channels, enabled) values (${vd.key}, ${vd.severity}, ${vd.threshold}, ${JSON.stringify(vd.channels)}::jsonb, ${vd.enabled})`);
      }
    } finally {
      await db.execute(sql`update ops.alert_rules set channels = ${JSON.stringify(before)}::jsonb where key = 'VulnerableDependency'`);
    }
  });

  // Watchbell 1.2.1: MonitorDomainMoved takes MonitorDown's channels (it fires instead of it), in both editions' seeds.
  it("seeds MonitorDomainMoved with MonitorDown's channels and allows monitor_update_url (cloud 0057 and self-host 0006)", async () => {
    const channels = async (key: string) =>
      rowsOf<{ channels: unknown }>(await db.execute(sql`select channels from ops.alert_rules where key = ${key}`)).map((r) => r.channels)[0];
    const seeds = [readFileSync(resolve("drizzle/0057_monitor_domain_moved.sql"), "utf8"), readFileSync(join(selfhostMigrationsFolder(), "0006_monitor_domain_moved.sql"), "utf8")];
    const before = await channels("MonitorDown");
    const run = async (seed: string) => { for (const stmt of seed.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt)); };
    try {
      for (const seed of seeds) {
        await db.execute(sql`delete from ops.alert_rules where key = 'MonitorDomainMoved'`);
        await db.execute(sql`update ops.alert_rules set channels = '["discord"]'::jsonb where key = 'MonitorDown'`);
        await run(seed);
        expect(await channels("MonitorDomainMoved")).toEqual(["discord"]);
        await db.execute(sql`update ops.alert_rules set channels = '["email_digest"]'::jsonb where key = 'MonitorDomainMoved'`);
        await run(seed);
        expect(await channels("MonitorDomainMoved")).toEqual(["email_digest"]);
      }
      const check = rowsOf<{ def: string }>(await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'action_proposals_action_check'`))[0];
      expect(check.def).toContain("monitor_update_url");
    } finally {
      await db.execute(sql`update ops.alert_rules set channels = ${JSON.stringify(before)}::jsonb where key = 'MonitorDown'`);
    }
  });

  it("upserts ai_agents on the coalesce(key_id) expression index, as src/private/ai/usage.ts does", async () => {
    const upsert = () =>
      db.execute(sql`insert into ops.ai_agents as a (key_id, client_name, via) values (null, 'probe', 'mcp')
        on conflict ((coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid)), client_name) do update set requests = a.requests + 1
        returning requests`);
    await upsert();
    expect(rowsOf<{ requests: number | string }>(await upsert()).map((r) => Number(r.requests))).toEqual([1]);
  });

  it("stores new wb_ console keys and keeps accepting wp_ ones from before the Watchbell rename (0004)", async () => {
    const insert = (name: string, prefix: string, hash: string) =>
      db.execute(sql`insert into ops.api_keys (name, prefix, key_hash, scopes, created_by)
        values (${name}, ${prefix}, ${hash}, array['read:status'], gen_random_uuid())`);
    await insert("new-key", "wb_7Hq2", "a".repeat(64));
    await insert("old-key", "wp_7Hq2", "b".repeat(64));
    await expect(insert("bad-key", "xx_7Hq2", "c".repeat(64))).rejects.toThrow();
  });

  it("supports transaction-scoped advisory locks (the scheduler's single-runner guard)", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('x'))`);
    });
  });

  it("has no Supabase roles, grants or row level security", () => {
    const text = baselineSql();
    expect(text).toContain('CREATE SCHEMA "ops"');
    for (const word of ["ops_app", "authenticated", "anon", "ROW LEVEL SECURITY"]) expect(text).not.toContain(word);
  });
});
