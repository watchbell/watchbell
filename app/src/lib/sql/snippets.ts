// Stage 9 slice 2: the console's starter queries. Each is a plain SELECT that passes lib/sql/guard.ts (a test runs
// them through it). The owner's own snippets live in the browser's localStorage only, never in the console database.

export type Snippet = { id: string; label: string; note?: string; sql: string };

export const BUILTIN_SNIPPETS: Snippet[] = [
  {
    id: "tables-by-size",
    label: "Tables by size",
    sql: `select n.nspname as schema, c.relname as table,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total,
  pg_size_pretty(pg_relation_size(c.oid)) as data,
  pg_total_relation_size(c.oid) as bytes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'm')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname !~ '^pg_toast'
order by bytes desc
limit 50`,
  },
  {
    id: "active-connections",
    label: "Active connections",
    note: "Other roles' query text shows only with pg_read_all_stats.",
    sql: `select pid, usename as role, application_name as app, state,
  now() - backend_start as connected_for,
  now() - query_start as query_for,
  wait_event_type, left(query, 200) as query
from pg_stat_activity
where datname = current_database()
order by query_start desc nulls last
limit 100`,
  },
  {
    id: "slow-queries",
    label: "Slow queries (pg_stat_statements)",
    note: "Needs the pg_stat_statements extension; errors if it isn't installed.",
    sql: `select calls, round(total_exec_time::numeric, 1) as total_ms,
  round(mean_exec_time::numeric, 1) as mean_ms, rows,
  left(query, 200) as query
from pg_stat_statements
order by mean_exec_time desc
limit 25`,
  },
  {
    id: "cache-hit-ratio",
    label: "Cache hit ratio",
    sql: `select 'tables' as kind,
  round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) as hit_pct
from pg_statio_user_tables
union all
select 'indexes',
  round(100.0 * sum(idx_blks_hit) / nullif(sum(idx_blks_hit) + sum(idx_blks_read), 0), 2)
from pg_statio_user_indexes`,
  },
  {
    id: "row-estimates",
    label: "Row counts (estimate)",
    note: "From the planner's statistics: fast, approximate, no table scan.",
    sql: `select schemaname as schema, relname as table, n_live_tup as rows_estimate,
  last_autoanalyze, last_autovacuum
from pg_stat_user_tables
order by n_live_tup desc
limit 100`,
  },
];

export const LOCAL_SNIPPETS_KEY = "watchpost.sql.snippets.v1";
export const MAX_LOCAL_SNIPPETS = 30;

// Reads the owner's saved snippets from localStorage text; anything malformed is dropped.
export function parseLocalSnippets(raw: string | null): Snippet[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is Snippet => !!s && typeof s === "object" && typeof (s as Snippet).id === "string"
      && typeof (s as Snippet).label === "string" && typeof (s as Snippet).sql === "string")
      .slice(0, MAX_LOCAL_SNIPPETS)
      .map((s) => ({ id: s.id.slice(0, 40), label: s.label.slice(0, 60), sql: s.sql.slice(0, 20_000) }));
  } catch {
    return [];
  }
}
