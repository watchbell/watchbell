import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { CREATE_STATUSES, CREATE_TYPES, SECRET_KEYS } from "@/lib/create/types";
import { createRequests } from "./create-schema";

// Stage 6 create requests: 0048 adds ops.create_requests, 0049 locks it down like every ops table.
const DIR = join(__dirname, "..", "..", "drizzle");

describe("0048_create_requests / 0049 lock-down", () => {
  const sql = readFileSync(join(DIR, "0048_create_requests.sql"), "utf8");
  const lock = readFileSync(join(DIR, "0049_create_requests_lockdown.sql"), "utf8").toLowerCase();

  it("creates the table additively; the snapshot knows its columns", () => {
    expect(sql).toContain('CREATE TABLE "ops"."create_requests"');
    expect(sql).not.toMatch(/drop |alter table|\brename\b/i);
    const cols = getTableConfig(createRequests).columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["type", "provider", "account_id", "inputs", "status", "requested_by", "approved_by", "result", "error", "expires_at"]));
    const snap = JSON.parse(readFileSync(join(DIR, "meta", "0049_snapshot.json"), "utf8")) as { tables: Record<string, { columns: Record<string, unknown> }> };
    expect(Object.keys(snap.tables["ops.create_requests"].columns).sort()).toEqual([...cols].sort());
  });

  it("locks it down: RLS, nothing for the browser roles, one ops_app policy, the contract's values", () => {
    expect(lock).toContain("alter table ops.create_requests enable row level security;");
    expect(lock).toContain("revoke all on ops.create_requests from anon, authenticated;");
    expect(lock.match(/create policy/g)).toHaveLength(1);
    expect(lock).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
    expect(lock).toContain(`check (type in (${CREATE_TYPES.map((t) => `'${t}'`).join(", ")}))`);
    expect(lock).toContain(`check (status in (${CREATE_STATUSES.map((t) => `'${t}'`).join(", ")}))`);
    expect(lock).toContain("expires_at <= created_at + interval '25 hours'");
  });

  it("refuses any secret-looking key in inputs or result at the database too", () => {
    const keys = `array[${SECRET_KEYS.map((k) => `'${k.toLowerCase()}'`).join(", ")}]`;
    expect(lock).toContain(`not (inputs ?| ${keys})`);
    expect(lock).toContain(`not (result ?| ${keys})`);
  });
});
