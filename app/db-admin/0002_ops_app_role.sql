-- Applied to the console's Supabase project on 2026-10-12 through the Supabase MCP
-- (migration "0002_ops_app_role"). Kept here as the record; drizzle-kit does not manage roles.
--
-- Least-privilege login used by the console's server (DATABASE_URL). It can read and write
-- the ops tables and nothing else. The password is NOT in this file: it was generated locally
-- and only a SCRAM-SHA-256 verifier was sent, with:
--   alter role ops_app with password 'SCRAM-SHA-256$4096:<salt>$<storedKey>:<serverKey>';
-- To rotate it, generate a new verifier the same way and update DATABASE_URL everywhere.
create role ops_app login noinherit;
grant usage on schema ops to ops_app;
grant select, insert, update, delete on all tables in schema ops to ops_app;
alter default privileges in schema ops grant select, insert, update, delete on tables to ops_app;

-- RLS stays on. Only ops_app gets a policy; anon/authenticated still have none (and no grants).
-- Every new ops table needs the same policy: default privileges cover grants, not policies.
create policy ops_app_all on ops.members  for all to ops_app using (true) with check (true);
create policy ops_app_all on ops.invites  for all to ops_app using (true) with check (true);
create policy ops_app_all on ops.accounts for all to ops_app using (true) with check (true);
create policy ops_app_all on ops.settings for all to ops_app using (true) with check (true);
