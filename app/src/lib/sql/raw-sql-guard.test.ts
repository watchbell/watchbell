import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// SQL injection guard (owner audit, 24 Nov 2026). Everything else reaches the database through Drizzle, where a value in
// sql`…${x}…` is always sent as a parameter. These calls put text into the statement itself, so each one was read and
// traced to its input in the audit. A new one (or one more in the same file) fails this test until someone checks that
// no request, form, cookie or database text can reach it, and adds it here with the reason.
const RAW_SQL = [/\bsql\.raw\(/g, /\.unsafe\(/g, /\bsql\.identifier\(/g];

const ALLOWED: Record<string, { count: number; why: string }> = {
  "lib/data/metrics-db.ts": { count: 3, why: "a truncated number of minutes, the constant column 2, a fixed bucket size literal" },
  "lib/data/pool-guard.ts": { count: 1, why: "pids read from pg_stat_activity, filtered to positive integers" },
  "private/ai/usage.ts": { count: 1, why: "a constant uuid literal" },
  "lib/sql/pg-driver.ts": { count: 2, why: "the owner-only SQL console: guarded statement, BEGIN READ ONLY, read-only role, on the user's own database" },
};

const SRC = join(process.cwd(), "src");
const isSource = (p: string) => /\.(ts|tsx|mts|cts)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !p.endsWith(".d.ts");

function rawSqlCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (!isSource(full)) continue;
    const text = readFileSync(full, "utf8");
    const n = RAW_SQL.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
    if (n) out[relative(SRC, full).split(sep).join("/")] = n;
  }
  return out;
}

describe("raw SQL stays where it was audited", () => {
  it("no file uses sql.raw, .unsafe or sql.identifier beyond the audited list", () => {
    const found = rawSqlCounts();
    const unexpected = Object.entries(found)
      .filter(([file, n]) => n !== (ALLOWED[file]?.count ?? 0))
      .map(([file, n]) => `${file}: ${n} (allowed ${ALLOWED[file]?.count ?? 0})`);
    expect(unexpected, "New raw SQL: check no user input can reach it, then add it to ALLOWED with the reason").toEqual([]);
  });

  // Final review 1.8.5 M4: exact counts, so a removed call can't leave a free slot for an unaudited one. A file the
  // public edition doesn't ship (part of src/private) is skipped; one that is there must still match.
  it("the list has no stale entries", () => {
    const found = rawSqlCounts();
    const stale = Object.keys(ALLOWED).filter((file) => existsSync(join(SRC, file)) && !found[file]);
    expect(stale, "Raw SQL removed from these files: drop them from ALLOWED").toEqual([]);
  });

  it("the scan sees the audited files (it isn't silently reading nothing)", () => {
    const found = rawSqlCounts();
    expect(found["lib/data/metrics-db.ts"]).toBe(3);
    expect(found["lib/sql/pg-driver.ts"]).toBe(2);
  });
});
