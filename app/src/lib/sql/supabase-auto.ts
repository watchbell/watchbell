import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { SUPABASE_POOLER, SUPABASE_REF } from "./dsn";
import { RO_ROLE } from "./role-sql";

// Stage 9 slice 2b: "Set up automatically (read-only)" for a Supabase project. The pure half: the password, its SCRAM
// verifier, the one idempotent setup script, the rollback script and the Transaction pooler string. lib/data/sql-auto-db.ts
// sends the scripts through the Management API and saves the string through the normal save-time check.
//
// The plaintext password never leaves this server: the script carries only a SCRAM-SHA-256 verifier (Postgres stores
// a pre-hashed password as is), so neither the API request nor a Postgres log line can show it.

export const PASSWORD_BYTES = 32; // 43 base64url characters
export const SCRAM_ITERATIONS = 4096;
export const POOLER_PORT = 6543; // Supavisor transaction mode

// 32 random bytes as base64url: letters, digits, "-" and "_" only (URL-safe, nothing to quote or escape).
export function generatePassword(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(PASSWORD_BYTES).toString("base64url");
}

export const PASSWORD_SHAPE = /^[A-Za-z0-9_-]{43,}$/;

const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();

// RFC 5802 / 7677 server-side secret, in the form Postgres stores in pg_authid.rolpassword.
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// Base64 only (no quote, backslash or dollar-dollar), so it is safe inside a single-quoted literal.
export const VERIFIER_SHAPE = /^SCRAM-SHA-256\$\d{4,7}:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

// The statements the setup runs, in order, inside one DO block (one implicit transaction: all or nothing). The role is
// created without any attribute (Postgres defaults: NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS);
// a re-run only resets the password. The save-time check then proves the role can't write.
export function setupStatements(verifier: string): string[] {
  if (!VERIFIER_SHAPE.test(verifier)) throw new Error("bad verifier");
  return [
    `if not exists (select 1 from pg_catalog.pg_roles where rolname = '${RO_ROLE}') then create role ${RO_ROLE} login password '${verifier}'; else alter role ${RO_ROLE} with login password '${verifier}'; end if;`,
    `alter role ${RO_ROLE} set default_transaction_read_only = on;`,
    `alter role ${RO_ROLE} set statement_timeout = '5s';`,
    `grant connect on database postgres to ${RO_ROLE};`,
    `grant usage on schema public to ${RO_ROLE};`,
    `grant select on all tables in schema public to ${RO_ROLE};`,
    `alter default privileges for role postgres in schema public grant select on tables to ${RO_ROLE};`,
    // Optional: lets "Active connections" and "Slow queries" see every role's activity. Skipped if not allowed.
    `begin grant pg_read_all_stats to ${RO_ROLE}; exception when others then null; end;`,
  ];
}

const doBlock = (body: string[]) => `do $watchpost$\nbegin\n${body.map((s) => `  ${s}`).join("\n")}\nend\n$watchpost$;`;

export const setupScript = (verifier: string): string => doBlock(setupStatements(verifier));

// After a failed check: take back every grant the setup gave and turn login off. Each step on its own, so one that
// fails (the role or a grant isn't there) doesn't stop the rest. Nothing is ever dropped.
export const ROLLBACK_STATEMENTS = [
  `revoke select on all tables in schema public from ${RO_ROLE};`,
  `alter default privileges for role postgres in schema public revoke select on tables from ${RO_ROLE};`,
  `revoke usage on schema public from ${RO_ROLE};`,
  `revoke connect on database postgres from ${RO_ROLE};`,
  `revoke pg_read_all_stats from ${RO_ROLE};`,
  `alter role ${RO_ROLE} nologin;`,
].map((s) => `begin ${s} exception when others then null; end;`);

export const rollbackScript = (): string => doBlock(ROLLBACK_STATEMENTS);

// What the Management API says about the project's poolers (GET /v1/projects/{ref}/config/database/pooler).
export type PoolerConfig = { database_type?: string; db_host?: string; db_name?: string; pool_mode?: string };

// The Transaction pooler string for the read-only role: user watchpost_ro.<ref>, port 6543, TLS required.
export function poolerDsn(configs: PoolerConfig[], ref: string, password: string): { ok: true; dsn: string } | { ok: false; error: string } {
  if (!SUPABASE_REF.test(ref)) return { ok: false, error: "This project's ref doesn't look right." };
  if (!PASSWORD_SHAPE.test(password)) return { ok: false, error: "The generated password isn't valid." };
  const primary = configs.filter((c) => !c.database_type || c.database_type === "PRIMARY");
  const host = primary.map((c) => (c.db_host ?? "").toLowerCase()).find((h) => SUPABASE_POOLER.test(h));
  if (!host) return { ok: false, error: "This project has no shared Supavisor pooler host (…pooler.supabase.com). Use the manual steps." };
  const db = primary.find((c) => c.db_name && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(c.db_name))?.db_name ?? "postgres";
  return { ok: true, dsn: `postgresql://${RO_ROLE}.${ref}:${encodeURIComponent(password)}@${host}:${POOLER_PORT}/${db}?sslmode=require` };
}
