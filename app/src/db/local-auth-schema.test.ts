import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selfhostMigrationsFolder } from "./pglite";

const dir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const code = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();

describe("0054 local auth (cloud)", () => {
  const text = code("0054_local_auth.sql");
  it("only adds the two local auth tables", () => {
    for (const t of ["local_users", "local_sessions"]) expect(text).toContain(`create table "ops"."${t}"`);
    expect(text).not.toMatch(/\bdrop\b/);
  });
  it("locks both tables down like every ops table", () => {
    for (const t of ["local_users", "local_sessions"]) {
      expect(text).toContain(`alter table ops.${t} enable row level security`);
      expect(text).toContain(`revoke all on ops.${t} from anon, authenticated`);
      expect(text).toContain(`grant select, insert, update, delete on ops.${t} to ops_app`);
      expect(text).toContain(`create policy ops_app_all on ops.${t} for all to ops_app using (true) with check (true)`);
    }
  });
});

describe("0003 local auth (self-host)", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  const hash = "a".repeat(64);
  beforeAll(async () => {
    client = await PGlite.create();
    db = drizzle({ client });
    await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  }, 120_000);
  afterAll(async () => {
    await client?.close();
  });

  it("has no Supabase roles or RLS in its migration", () => {
    const sh = readFileSync(join(selfhostMigrationsFolder(), "0003_local_auth.sql"), "utf8").toLowerCase();
    expect(sh).not.toMatch(/row level security|anon|authenticated|ops_app/);
  });

  it("enforces the value checks, uniqueness and cascade", async () => {
    const pw = "scrypt$32768$8$1$c2FsdA==$aGFzaA==";
    const ins = (email: string, ph = pw) => db.execute(sql`insert into ops.local_users (email, password_hash) values (${email}, ${ph}) returning id`);
    const id = (await ins("a@example.com")).rows[0].id as string;
    await expect(ins("a@example.com")).rejects.toThrow();
    await expect(ins("b@example.com", "plain")).rejects.toThrow();
    await expect(ins("B@example.com")).rejects.toThrow();
    await expect(ins("a b@example.com")).rejects.toThrow();
    const session = (token: string, aal: string, ua: string | null = null) =>
      db.execute(sql`insert into ops.local_sessions (user_id, token_hash, aal, expires_at, user_agent) values (${id}, ${token}, ${aal}, now() + interval '30 days', ${ua})`);
    await session(hash, "aal1");
    await expect(session(hash, "aal1")).rejects.toThrow();
    await expect(session("b".repeat(64), "aal3")).rejects.toThrow();
    await expect(session("short", "aal1")).rejects.toThrow();
    await expect(session("c".repeat(64), "aal1", "x".repeat(201))).rejects.toThrow();
    await db.execute(sql`delete from ops.local_users where id = ${id}`);
    expect((await db.execute(sql`select count(*)::int as n from ops.local_sessions`)).rows[0].n).toBe(0);
  });
});
