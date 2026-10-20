import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDsn } from "./dsn";
import { guardSql } from "./guard";
import {
  generatePassword, PASSWORD_SHAPE, poolerDsn, ROLLBACK_STATEMENTS, rollbackScript, scramVerifier, setupScript, setupStatements, VERIFIER_SHAPE,
} from "./supabase-auto";

const REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-ap-southeast-1.pooler.supabase.com";
const VERIFIER = scramVerifier("fake-password-for-tests-only-0123456789abcd", Buffer.alloc(16, 7));

describe("generatePassword", () => {
  it("is 43 URL-safe characters from 32 random bytes, with nothing to quote", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(PASSWORD_SHAPE);
      expect(p).toHaveLength(43);
      expect(p).not.toMatch(/['"\\$%@:/?#\s]/);
    }
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });
});

describe("scramVerifier", () => {
  // RFC 7677 §3: user "user", password "pencil". A server holding only this verifier must accept the RFC's client
  // proof and produce the RFC's server signature, so StoredKey and ServerKey are both right.
  it("matches the RFC 7677 SCRAM-SHA-256 test vector", () => {
    const v = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"), 4096);
    expect(v).toMatch(VERIFIER_SHAPE);
    const [, rest] = v.split("$4096:");
    const [, keys] = rest.split("$");
    const [stored, server] = keys.split(":").map((k) => Buffer.from(k, "base64"));
    const auth = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const proof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");
    const sig = createHmac("sha256", stored).update(auth).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ sig[i]));
    expect(createHash("sha256").update(clientKey).digest().equals(stored)).toBe(true);
    expect(createHmac("sha256", server).update(auth).digest("base64")).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  });

  it("never contains the password and uses a fresh salt each time", () => {
    const pw = generatePassword();
    const a = scramVerifier(pw);
    expect(a).not.toContain(pw);
    expect(a).not.toBe(scramVerifier(pw));
  });
});

// The only statements the setup may run. Anything else in the script fails the test.
const ALLOWED = [
  /^if not exists \(select 1 from pg_catalog\.pg_roles where rolname = 'watchpost_ro'\) then create role watchpost_ro login password '[^']+'; else alter role watchpost_ro with login password '[^']+'; end if;$/,
  /^alter role watchpost_ro set default_transaction_read_only = on;$/,
  /^alter role watchpost_ro set statement_timeout = '5s';$/,
  /^grant connect on database postgres to watchpost_ro;$/,
  /^grant usage on schema public to watchpost_ro;$/,
  /^grant select on all tables in schema public to watchpost_ro;$/,
  /^alter default privileges for role postgres in schema public grant select on tables to watchpost_ro;$/,
  /^begin grant pg_read_all_stats to watchpost_ro; exception when others then null; end;$/,
];

describe("setupScript", () => {
  it("contains exactly the allowed statements, in order, in one DO block", () => {
    const stmts = setupStatements(VERIFIER);
    expect(stmts).toHaveLength(ALLOWED.length);
    stmts.forEach((s, i) => expect(s).toMatch(ALLOWED[i]));
    const script = setupScript(VERIFIER);
    expect(script.startsWith("do $watchpost$\nbegin\n")).toBe(true);
    expect(script.endsWith("\nend\n$watchpost$;")).toBe(true);
    const body = script.split("\n").slice(2, -2).map((l) => l.trim());
    expect(body).toEqual(stmts);
  });

  it("grants nothing that writes and gives no role attribute", () => {
    const s = setupScript(VERIFIER).toLowerCase().replace(/password '[^']+'/g, "password '…'");
    for (const bad of ["insert", "update", "delete", "truncate", "drop", "references", "trigger", "superuser", "createrole", "createdb", "replication", "bypassrls", "grant all", "with grant option", "with admin", "pg_write", "pg_execute_server_program", "pg_read_server_files", "service_role", "authenticated", "security definer"]) {
      expect(s, bad).not.toContain(bad);
    }
    expect(s.match(/\bgrant\b/g)).toHaveLength(5);
    expect(s).not.toMatch(/\bgrant\s+(?!connect|usage|select|pg_read_all_stats)/);
    expect(s).not.toMatch(/create (table|schema|function|extension|policy)/);
  });

  it("is idempotent: create only when the role is missing, else only reset the password", () => {
    const [role] = setupStatements(VERIFIER);
    expect(role.match(/create role/g)).toHaveLength(1);
    expect(role.indexOf("if not exists")).toBeLessThan(role.indexOf("create role"));
    expect(role.indexOf("create role")).toBeLessThan(role.indexOf("else alter role"));
    // Everything else is a GRANT / ALTER ... SET, which Postgres accepts again on a re-run.
    for (const s of setupStatements(VERIFIER).slice(1)) expect(s).toMatch(/^(alter role watchpost_ro set|grant|alter default privileges|begin grant)/);
    // Same input, same script.
    expect(setupScript(VERIFIER)).toBe(setupScript(VERIFIER));
  });

  it("carries the SCRAM verifier, never a plaintext password, and refuses anything that could break the literal", () => {
    expect(setupScript(VERIFIER)).toContain(VERIFIER);
    for (const bad of ["plain-password", "SCRAM-SHA-256$4096:abc'; drop role x; --$x:y", `${VERIFIER}'`]) {
      expect(() => setupScript(bad)).toThrow();
    }
  });

  it("is not something the console's own guard would ever let through (it only runs via the API)", () => {
    expect(guardSql(setupScript(VERIFIER)).ok).toBe(false);
  });
});

describe("rollbackScript", () => {
  it("only revokes and turns login off, each step on its own, and never drops", () => {
    const s = rollbackScript();
    expect(s).not.toMatch(/\bdrop\b|\bgrant\b(?! option)|create /i);
    for (const st of ROLLBACK_STATEMENTS) expect(st).toMatch(/^begin (revoke .+ from watchpost_ro;|alter default privileges for role postgres in schema public revoke select on tables from watchpost_ro;|alter role watchpost_ro nologin;) exception when others then null; end;$/);
    expect(s).toContain("revoke select on all tables in schema public from watchpost_ro;");
    expect(s).toContain("revoke connect on database postgres from watchpost_ro;");
    expect(s).toContain("alter role watchpost_ro nologin;");
  });
});

describe("poolerDsn", () => {
  const pw = "A".repeat(43);
  it("builds the Transaction pooler string: watchpost_ro.<ref>, port 6543, sslmode=require", () => {
    const r = poolerDsn([{ database_type: "PRIMARY", db_host: HOST, db_name: "postgres", pool_mode: "transaction" }], REF, pw);
    expect(r).toEqual({ ok: true, dsn: `postgresql://watchpost_ro.${REF}:${pw}@${HOST}:6543/postgres?sslmode=require` });
    // and the normal parser (the one the save uses) accepts it for this project only
    const parsed = parseDsn(r.ok ? r.dsn : "", "supabase", REF);
    expect(parsed).toMatchObject({ ok: true, role: "watchpost_ro", dsn: { host: HOST, port: 6543, user: `watchpost_ro.${REF}`, password: pw, database: "postgres" } });
    expect(parseDsn(r.ok ? r.dsn : "", "supabase", "zzzzzzzzzzzzzzzzzzzz").ok).toBe(false);
  });

  it("uses port 6543 even when the API lists the session pooler, and skips read replicas", () => {
    const r = poolerDsn([
      { database_type: "READ_REPLICA", db_host: "aws-0-eu-west-1.pooler.supabase.com" },
      { database_type: "PRIMARY", db_host: HOST.toUpperCase(), pool_mode: "session" },
    ], REF, pw);
    expect(r).toEqual({ ok: true, dsn: `postgresql://watchpost_ro.${REF}:${pw}@${HOST}:6543/postgres?sslmode=require` });
  });

  it("refuses a host that isn't the shared Supavisor pooler, a bad ref or a bad password", () => {
    expect(poolerDsn([{ database_type: "PRIMARY", db_host: `db.${REF}.supabase.co` }], REF, pw).ok).toBe(false);
    expect(poolerDsn([{ database_type: "PRIMARY", db_host: "evil.example.com" }], REF, pw).ok).toBe(false);
    expect(poolerDsn([], REF, pw).ok).toBe(false);
    expect(poolerDsn([{ db_host: HOST }], "bad-ref", pw).ok).toBe(false);
    expect(poolerDsn([{ db_host: HOST }], REF, "short'pw").ok).toBe(false);
  });

  it("puts no password in an error", () => {
    const r = poolerDsn([], REF, pw);
    expect(JSON.stringify(r)).not.toContain(pw);
  });
});
