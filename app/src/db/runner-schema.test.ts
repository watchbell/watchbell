import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stage 9 slice 4 migrations: three additive tables, the usual lock-down and value checks.
const dir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const code = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0051 / 0052 runner", () => {
  const create = code("0051_runner.sql");
  const lock = code("0052_runner_lockdown.sql").toLowerCase();

  it("only creates the three runner tables", () => {
    for (const t of ["runners", "runner_repo_settings", "runner_jobs"]) expect(create).toContain(`CREATE TABLE "ops"."${t}"`);
    expect(create).not.toMatch(/\bDROP\b/);
    expect(create).not.toMatch(/ALTER TABLE "ops"\."(?!runner)/);
    expect(create).toContain('"token_hash" text NOT NULL');
    expect(create).not.toMatch(/"token" text/);
  });

  it("locks every table down like every ops table", () => {
    for (const t of ["runners", "runner_repo_settings", "runner_jobs"]) {
      expect(lock).toContain(`alter table ops.${t} enable row level security`);
      expect(lock).toContain(`revoke all on ops.${t} from anon, authenticated`);
      expect(lock).toContain(`grant select, insert, update, delete on ops.${t} to ops_app`);
      expect(lock).toContain(`create policy ops_app_all on ops.${t} for all to ops_app using (true) with check (true)`);
    }
  });

  it("bounds the values: one active runner, hashed tokens, preview ports 4100–4199, own branches for lockfile jobs", () => {
    expect(lock).toContain("create unique index runners_one_active on ops.runners ((true)) where revoked_at is null");
    expect(lock).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(lock).toContain("port between 4100 and 4199");
    expect(lock).toContain("kind <> 'lockfile' or ref ~ '^watchpost/deps-[0-9a-f]{8}$'");
    expect(lock).toContain("char_length(logs) <= 40000");
  });
});
