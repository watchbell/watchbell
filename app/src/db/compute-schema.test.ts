import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stage 12 migrations: two additive tables, the usual lock-down, value checks and the ComputeHigh seed.
const dir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const code = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0036 / 0037 supabase compute", () => {
  const create = code("0036_supabase_compute.sql");
  const lock = code("0037_supabase_compute_lockdown.sql").toLowerCase();

  it("only creates the two ops tables, removed with their project", () => {
    expect(create).toContain('CREATE TABLE "ops"."supabase_metrics_keys"');
    expect(create).toContain('CREATE TABLE "ops"."supabase_metrics"');
    expect(create).toContain('PRIMARY KEY("resource_id","hour")');
    expect(create.match(/ON DELETE cascade/g)).toHaveLength(2);
    expect(create).not.toMatch(/\b(DROP|ALTER TABLE "ops"\."(?!supabase_metrics))/);
  });

  it("locks both tables down like every ops table", () => {
    for (const t of ["supabase_metrics_keys", "supabase_metrics"]) {
      expect(lock).toContain(`alter table ops.${t} enable row level security`);
      expect(lock).toContain(`revoke all on ops.${t} from anon, authenticated`);
      expect(lock).toContain(`grant select, insert, update, delete on ops.${t} to ops_app`);
      expect(lock).toContain(`create policy ops_app_all on ops.${t} for all to ops_app using (true) with check (true)`);
    }
  });

  it("bounds the error text and the percentages, and seeds ComputeHigh without overwriting edits", () => {
    expect(lock).toContain("char_length(last_error) <= 300");
    expect(lock).toContain("cpu_avg between 0 and 100");
    expect(lock).toContain("('computehigh', 'warning', 80,");
    expect(lock).toContain("on conflict (key) do nothing");
  });
});
