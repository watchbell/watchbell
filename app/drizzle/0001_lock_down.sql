-- Only the server (table owner via the pooler) reads these tables. Browser keys get nothing.
alter table ops.members enable row level security;
alter table ops.invites enable row level security;
alter table ops.accounts enable row level security;
alter table ops.settings enable row level security;
revoke all on schema ops from anon, authenticated;
revoke all on all tables in schema ops from anon, authenticated;
revoke all on all sequences in schema ops from anon, authenticated;
revoke all on all functions in schema ops from anon, authenticated;
alter default privileges in schema ops revoke all on tables from anon, authenticated;
alter default privileges in schema ops revoke all on sequences from anon, authenticated;
alter default privileges in schema ops revoke all on functions from anon, authenticated;
