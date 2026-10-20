import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stage 9 slice 2 migrations: one additive table, the usual lock-down and value checks.
const dir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const code = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0038 / 0039 sql connections", () => {
  const create = code("0038_sql_connections.sql");
  const lock = code("0039_sql_connections_lockdown.sql").toLowerCase();

  it("only creates ops.sql_connections, removed with its database", () => {
    expect(create).toContain('CREATE TABLE "ops"."sql_connections"');
    expect(create).toContain('"dsn_ciphertext" text NOT NULL');
    expect(create.match(/ON DELETE cascade/g)).toHaveLength(1);
    expect(create).not.toMatch(/\b(DROP|ALTER TABLE "ops"\."(?!sql_connections))/);
  });

  it("locks the table down like every ops table and bounds its values", () => {
    expect(lock).toContain("alter table ops.sql_connections enable row level security");
    expect(lock).toContain("revoke all on ops.sql_connections from anon, authenticated");
    expect(lock).toContain("grant select, insert, update, delete on ops.sql_connections to ops_app");
    expect(lock).toContain("create policy ops_app_all on ops.sql_connections for all to ops_app using (true) with check (true)");
    expect(lock).toContain("provider in ('supabase', 'neon')");
    expect(lock).toContain("char_length(dsn_ciphertext) between 1 and 4000");
  });
});
