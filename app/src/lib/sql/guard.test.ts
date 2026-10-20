import { describe, expect, it } from "vitest";
import { guardSql, lex, MAX_SQL_CHARS, sqlFingerprint } from "./guard";

const ok = (sql: string) => expect(guardSql(sql), sql).toMatchObject({ ok: true });
const no = (sql: string, msg?: RegExp) => {
  const r = guardSql(sql);
  expect(r.ok, sql).toBe(false);
  if (msg && !r.ok) expect(r.error, sql).toMatch(msg);
};

describe("guardSql: what may run", () => {
  it.each([
    "select 1",
    "SELECT * FROM users LIMIT 10",
    "  select 1;  ",
    "select 1;;",
    "select 1; -- trailing comment",
    "select 1 /* ; drop table x */",
    "with t as (select 1 as x) select * from t",
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r",
    "explain select * from t",
    "EXPLAIN (FORMAT JSON) SELECT 1",
    "explain verbose select 1",
    "show statement_timeout",
    "show all",
    "table users",
    "(select 1) union (select 2)",
    "select ';' as semi",
    "select 'it''s; fine' as s",
    "select $$ ; delete from t; $$ as body",
    "select $tag$ insert into x $tag$",
    "select E'\\'; delete from t; --' as escaped",
    'select "update" from t',
    'select "insert", "delete", "into" from "set"',
    "select substring('abc' from 1 for 2)",
    "select * from t fetch first 5 rows only",
    "select pg_size_pretty(pg_database_size(current_database()))",
    "select a$b from t",
    "select 1 -- insert into x",
    "/* nested /* comment */ still comment; drop table t */ select 1",
    "select current_setting('transaction_read_only')",
    "select 1e10, .5, 3.14",
  ])("allows %s", (sql) => ok(sql));
});

describe("guardSql: what is refused", () => {
  it("refuses a second statement, whatever hides around it", () => {
    no("select 1; select 2", /one statement/);
    no("select 1; drop table users", /one statement/);
    no("select ';'; delete from t", /one statement/);
    no("select 1 /* c */ ; /* c */ update t set x = 1", /one statement/);
    // Without E, a backslash doesn't escape: the string ends at the second quote, so `; delete …` is real SQL.
    no("select '\\'; delete from t; --'", /one statement/);
    // Postgres nests block comments: the first */ doesn't end it, so a naive stripper would see something else.
    no("/* a /* b */ */ select 1; drop table t");
  });

  it("refuses statements that aren't reads", () => {
    for (const s of [
      "insert into t values (1)", "update t set x = 1", "delete from t", "merge into t using s on true when matched then delete",
      "truncate t", "drop table t", "create table t (x int)", "alter table t add column y int", "grant select on t to public",
      "copy t to stdout", "copy (select 1) to program 'id'", "do $$ begin delete from t; end $$", "call p()",
      "vacuum", "analyze t", "lock table t", "begin", "commit", "rollback", "prepare p as select 1", "execute p",
      "listen x", "notify x", "set statement_timeout = 0", "reset all", "set role postgres", "discard all",
      "refresh materialized view m", "values (1)", "declare c cursor for select 1", "fetch all from c",
    ]) no(s);
  });

  it("refuses SET and friends everywhere, our own SET LOCAL lines never go through the guard", () => {
    no("set local statement_timeout = '0'");
    no("SET search_path = evil");
    no("select 1 from t where x in (select 1) and set");
  });

  it("refuses data-modifying CTEs", () => {
    no("with d as (delete from t returning *) select * from d", /DELETE/);
    no("with u as (update t set x = 1 returning *) select 1", /UPDATE/);
    no("with i as (insert into t values (1) returning *) select * from i");
    no("WITH m AS (MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE) SELECT 1");
  });

  it("refuses SELECT … INTO", () => {
    no("select * into new_table from t", /INTO/);
    no("SELECT 1 INTO TEMP x");
  });

  it("refuses EXPLAIN ANALYZE in every spelling", () => {
    no("explain analyze select 1", /EXPLAIN ANALYZE/);
    no("EXPLAIN ANALYSE SELECT 1", /EXPLAIN ANALYZE/);
    no("explain (analyze, buffers) select 1", /EXPLAIN ANALYZE/);
    no("explain (format json, analyze true) delete from t");
  });

  it("refuses row locks", () => {
    for (const s of ["select * from t for update", "select * from t for no key update", "select * from t for share", "select * from t for key share", "select * from t for update skip locked"]) no(s);
  });

  it("refuses functions with side effects a READ ONLY transaction doesn't stop", () => {
    no("select set_config('statement_timeout', '0', true)", /set_config/);
    no("select pg_catalog.set_config('statement_timeout', '0', false)", /set_config/);
    no('select "set_config"(\'statement_timeout\', \'0\', true)', /set_config/);
    no("select pg_terminate_backend(123)");
    no("select pg_cancel_backend(pid) from pg_stat_activity");
    no("select dblink_exec('host=x', 'delete from t')");
    no("select * from dblink('host=x', 'select 1') as t(x int)");
    no("select http_post('https://example.com', 'x', 'text/plain')");
    no("select pg_read_file('/etc/passwd')");
    no("select pg_ls_dir('.')");
    no("select pg_advisory_lock(1)");
    no("select lo_import('/etc/passwd')");
    no("select query_to_xml('set statement_timeout = 0', true, true, '')");
    no("select pg_reload_conf()");
    no("select pg_notify('c', 'x')");
  });

  it("refuses what it can't lex with certainty", () => {
    no("select 'unterminated", /isn't closed/);
    no("select E'still \\' open", /isn't closed/);
    no("select $x$ never closed", /isn't closed/);
    no("/* never closed select 1", /isn't closed/);
    no('select "open', /isn't closed/);
  });

  it("refuses empty input, parameters, NUL bytes, huge input and non-strings", () => {
    no("", /Write a query/);
    no("   ;  ", /Write a query/);
    no("-- just a comment", /Write a query/);
    no("select $1", /Parameters/);
    no("select 1\u0000");
    no(`select ${"1".repeat(MAX_SQL_CHARS)}`, /under/);
    expect(guardSql(42 as unknown as string).ok).toBe(false);
    expect(guardSql(null).ok).toBe(false);
  });

  it("returns the trimmed text and the first keyword", () => {
    expect(guardSql("\n  SELECT 1;\n")).toEqual({ ok: true, text: "SELECT 1;", kind: "select" });
  });
});

describe("lex", () => {
  it("keeps quoted names apart from words and drops strings and comments", () => {
    const r = lex(`select "Name", 'x' -- c\n from t`);
    expect(r).toEqual({ ok: true, tokens: [
      { t: "word", v: "select" }, { t: "qident", v: "Name" }, { t: "punct", v: "," }, { t: "string" }, { t: "word", v: "from" }, { t: "word", v: "t" },
    ] });
  });
});

describe("sqlFingerprint", () => {
  it("is 12 hex, ignores literals and case, and differs by shape", () => {
    const a = sqlFingerprint("select * from users where email = 'a@example.com'");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(sqlFingerprint("SELECT * FROM users WHERE email = 'b@example.com'")).toBe(a);
    expect(sqlFingerprint("select * from users where id = 42")).not.toBe(a);
    expect(a).not.toContain("example");
  });
});
