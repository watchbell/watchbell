import type { SqlProvider } from "./dsn";

// Stage 9 slice 2: the copy-paste SQL the "SQL access" dialog shows, per provider. The owner runs it in the provider's
// own SQL editor; the console never creates roles. The password is a placeholder the owner replaces.

export const RO_ROLE = "watchpost_ro";

export function roleSql(provider: SqlProvider): string {
  const db = provider === "supabase" ? "postgres" : "neondb";
  const owner = provider === "supabase" ? "postgres" : "neondb_owner";
  return `-- Run as ${owner} in the ${provider === "supabase" ? "Supabase SQL Editor" : "Neon SQL Editor"}. Use a long random password.
create role ${RO_ROLE} login password 'REPLACE-with-a-long-random-password';
alter role ${RO_ROLE} set default_transaction_read_only = on;
alter role ${RO_ROLE} set statement_timeout = '5s';
grant connect on database ${db} to ${RO_ROLE};
grant usage on schema public to ${RO_ROLE};
grant select on all tables in schema public to ${RO_ROLE};
alter default privileges for role ${owner} in schema public grant select on tables to ${RO_ROLE};
-- Optional: lets "Active connections" and "Slow queries" see every role's activity.
grant pg_read_all_stats to ${RO_ROLE};`;
}

export function connectionHint(provider: SqlProvider): string {
  return provider === "supabase"
    ? `Supabase → Connect → Transaction pooler, with the user changed to ${RO_ROLE}.<project-ref>: postgresql://${RO_ROLE}.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
    : `Neon → Connect, with the role changed to ${RO_ROLE}: postgresql://${RO_ROLE}:<password>@ep-…-pooler.<region>.aws.neon.tech/neondb`;
}

export const RLS_NOTE = "Tables with row level security return no rows to this role unless a policy allows it (for example create policy watchpost_ro_read on public.<table> for select to watchpost_ro using (true)).";

// Optional, shown with a Copy button and never run by the console: one SELECT-only policy per public table that has
// row level security on, so the read-only role sees its rows. Review it first: it lets watchpost_ro read every row.
export const RLS_POLICY_SQL = `-- Optional. Run as postgres in the Supabase SQL Editor after reviewing it.
-- Adds a SELECT-only policy for ${RO_ROLE} on every public table with row level security on.
do $$
declare t record;
begin
  for t in select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      and not exists (select 1 from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = '${RO_ROLE}_read')
  loop
    execute format('create policy ${RO_ROLE}_read on public.%I for select to ${RO_ROLE} using (true)', t.relname);
  end loop;
end
$$;`;

export const NEON_NOTE = "Neon: API can't grant SELECT; run the SQL once.";
