# SQL console

**Database › SQL console** (owner only) runs read-only queries against the Supabase and Neon databases you watch, and
has a query builder for Firestore. It is meant for looking, not changing: every query runs as a read-only database
role you create for Watchbell, inside a read-only transaction that is rolled back afterwards.

- [Give Watchbell read-only access](#give-watchbell-read-only-access)
- [Row level security](#row-level-security)
- [Running queries](#running-queries)
- [Postgres for MySQL users](#postgres-for-mysql-users)
- [Firestore](#firestore)
- [Removing access](#removing-access)

## Give Watchbell read-only access

Open the **SQL access** tab. Every watched Supabase project and Neon project has a row; press **Add SQL access** on one.

### Supabase: automatic

**Set up automatically (read-only)** creates the role for you through the Supabase Management API. It needs a
Supabase token with **Database: Read-write** and **Connection pooling: Read** (see
[Providers](providers.md#supabase)); if the token lacks them, the dialog says which one is missing (for example
`database_write`) and you can replace the token or use the manual steps. The generated password never leaves your
machine: only a SCRAM hash of it is sent to Supabase.

### Supabase and Neon: by hand

1. Run this once in the provider's SQL editor (Supabase: SQL Editor, as `postgres`; Neon: SQL Editor, as
   `neondb_owner`, and use `neondb` instead of `postgres` in the `grant connect` line). Replace the password with a
   long random one.

   ```sql
   create role watchpost_ro login password 'REPLACE-with-a-long-random-password';
   alter role watchpost_ro set default_transaction_read_only = on;
   alter role watchpost_ro set statement_timeout = '5s';
   grant connect on database postgres to watchpost_ro;
   grant usage on schema public to watchpost_ro;
   grant select on all tables in schema public to watchpost_ro;
   alter default privileges for role postgres in schema public grant select on tables to watchpost_ro;
   -- Optional: lets "Active connections" and "Slow queries" see every role's activity.
   grant pg_read_all_stats to watchpost_ro;
   ```

   (On Neon, the `alter default privileges` line names `neondb_owner` instead of `postgres`. The dialog shows the
   exact script for each provider with a Copy button.)

2. Build the connection string with the new role:

   - **Supabase:** Connect › **Transaction pooler**, with the user changed to `watchpost_ro.<project-ref>`:
     `postgresql://watchpost_ro.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.
     Use the pooler string; the direct `db.<ref>.supabase.co` host is refused.
   - **Neon:** Connect, with the role changed to `watchpost_ro`:
     `postgresql://watchpost_ro:<password>@ep-…-pooler.<region>.aws.neon.tech/neondb`.

3. Paste it in the dialog and press **Test and save**. Saving connects once and checks that the role **can't write**; a role that can is refused.
   The roles `postgres`, `supabase_admin` and `service_role` are refused outright. The string is encrypted and never
   shown again.

If a password contains `# @ [ ] / ? :`, URL-encode it in the string, or pick a password of letters and digits.

A Neon compute that is idle has to wake up for a query (which uses CU-hours). Watchbell never wakes one on its own:
it asks "Running this will wake the Neon compute (uses CU-hours). Run anyway?" first.

## Row level security

Supabase tables usually have **row level security (RLS)** on. The `watchpost_ro` role doesn't own the tables and
doesn't bypass RLS, so a table with RLS on returns **no rows** to it, without an error, unless a policy allows it.

To let Watchbell read one table, add a SELECT-only policy for this role only (your app's own roles are not affected):

```sql
create policy watchpost_ro_read on public.<table> for select to watchpost_ro using (true);
```

The dialog also has an optional script (never run for you) that adds this policy to every public table with RLS on.
Review it first: it lets `watchpost_ro` read every row of those tables.

## Running queries

On the **Postgres** tab, pick a database by its alias, write a query and run it.

- Only one statement at a time, and only `SELECT`, `WITH`, `EXPLAIN` (without `ANALYZE`), `SHOW` and `TABLE`.
  Parameters such as `$1` aren't supported; write the value into the query.
- Limits: 5 seconds per statement, 2 seconds waiting for a lock, at most 500 rows and 100 columns shown, long values
  cut at 2,000 characters.
- Every run is checked on the server first, then runs in a `READ ONLY` transaction that is rolled back. The database
  enforces it again through the role.
- Every run is audited in Events with the database alias and a fingerprint of the query, never the query text.
- Built-in snippets: tables by size, active connections, slow queries (needs the `pg_stat_statements` extension),
  cache hit ratio, row counts (estimate). Your own snippets are saved in your browser only (up to 30), not in
  Watchbell.

## Postgres for MySQL users

Supabase and Neon run Postgres. If you know MySQL, these are the differences you'll hit first:

| You want | MySQL | Postgres (works here) |
|---|---|---|
| List tables | `SHOW TABLES;` | `select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2;` |
| Columns of a table | `DESCRIBE users;` | `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'users' order by ordinal_position;` |
| Indexes of a table | `SHOW INDEX FROM users;` | `select indexname, indexdef from pg_indexes where tablename = 'users';` |
| List databases | `SHOW DATABASES;` | `select datname from pg_database;` (a connection is always to one database) |
| Running queries | `SHOW PROCESSLIST;` | the "Active connections" snippet (`pg_stat_activity`) |
| Quote a name | `` `Order` `` | `"Order"` (unquoted names are folded to lower case) |
| Text value | `'text'` or `"text"` | `'text'` only; double quotes are for names |
| Skip and take rows | `LIMIT 20, 10` | `LIMIT 10 OFFSET 20` |
| Null fallback | `IFNULL(a, b)` | `coalesce(a, b)` |
| Case-insensitive match | `LIKE` (depends on collation) | `ILIKE` |

Other things to know:

- `SHOW` in Postgres shows a setting (`show server_version;`), not tables.
- psql shortcuts like `\dt` and `\d users` are commands of the psql program, not SQL; they don't work here.
- Your tables are usually in the schema `public`. The role only has access to `public`, so Supabase's own schemas
  (`auth`, `storage`) are not visible.

## Firestore

The **Firestore** tab lists your root collections and builds simple queries (a collection, field conditions, an
order) and runs them with the Firebase
account's service account, which needs `datastore.viewer` on the project. Each query counts against your free
Firestore reads; the tab shows today's reads.

## Removing access

On the SQL access tab, **Remove** deletes the stored connection string. Drop the role in the database too:

```sql
drop owned by watchpost_ro;
drop role watchpost_ro;
```
