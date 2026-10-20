import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { recordAction } from "@/lib/data/audit-db";

// Pool guard (owner 16 Oct: "max 10 only, because the limit is 15"). Every Vercel instance holds one pooled connection
// (src/db/client.ts) and the Supabase session pooler has 15 client slots; warm instances (the runner polls every 10 s,
// the minute cron, open pages) and the ones left over after a deploy can fill them all, and then every page fails
// with "Something went wrong". Once a minute: when the app role holds POOL_CAP or more connections, the ones idle the
// longest (at least IDLE_MIN_S) are closed until it is back at the cap. Only this app's own role, never anything busy.
export const POOL_SLOTS = 15;
export const POOL_CAP = 10;
export const IDLE_MIN_S = 10;

// Pure: how many idle connections to close when the role holds `total` (this one included).
export const trimCount = (total: number, cap = POOL_CAP): number => Math.max(0, total - cap);

export const BUSY_MAX_S = 60;

export type PoolGuard = { total: number; trimmed: number; culprits: string[] };
export type GuardConn = { pid: number; state: string | null; idleS: number; runS: number; table: string | null };

// Pure (owner 16 Oct: "close the ones really not in use; if all are equal, pick the one that is too high"): which connections to
// close to get back to `cap` (this one counted). Idle ones first, longest idle first (idle at least idleMinS); when that
// isn't enough, queries running longer than BUSY_MAX_S, longest first. A short busy query is never touched.
export function pickVictims(conns: GuardConn[], cap = POOL_CAP, idleMinS = IDLE_MIN_S): GuardConn[] {
  // Doubles (owner 16 Oct: "never leave doubles"): idle connections whose last query hit the same table as a
  // more recently used idle one are closed even under the cap; the most recent one per table stays.
  const dupes = doubles(conns);
  const rest = conns.filter((c) => !dupes.includes(c));
  const excess = Math.max(0, rest.length + 1 - cap);
  if (!excess) return dupes;
  const idle = rest.filter((c) => c.state === "idle" && c.idleS >= idleMinS).sort((a, b) => b.idleS - a.idleS);
  const slow = rest.filter((c) => c.state !== "idle" && c.runS > BUSY_MAX_S).sort((a, b) => b.runS - a.runS);
  return [...dupes, ...[...idle, ...slow].slice(0, excess)];
}

export const DOUBLE_IDLE_S = 60;

// Pure: the idle (≥ DOUBLE_IDLE_S) connections that repeat a table a fresher idle connection also last touched.
export function doubles(conns: GuardConn[]): GuardConn[] {
  const seen = new Set<string>();
  const out: GuardConn[] = [];
  for (const c of conns.filter((x) => x.state === "idle" && x.table).sort((a, b) => a.idleS - b.idleS)) {
    if (seen.has(c.table!)) { if (c.idleS >= DOUBLE_IDLE_S) out.push(c); } else seen.add(c.table!);
  }
  return out;
}

// Pure: "monitors ×3, settings ×1" for the event line.
export function culpritText(victims: GuardConn[]): string[] {
  const n = new Map<string, number>();
  for (const v of victims) n.set(v.table ?? "unknown", (n.get(v.table ?? "unknown") ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t, k]) => `${t} ×${k}`);
}

async function ownConns(): Promise<GuardConn[]> {
  const rows = await db().execute(sql`
    select pid, state, extract(epoch from now() - state_change)::int as idle_s,
      coalesce(extract(epoch from now() - query_start)::int, 0) as run_s, left(query, 400) as query
    from pg_stat_activity where usename = current_user and pid <> pg_backend_pid()`);
  return rowsOf<{ pid: number; state: string | null; idle_s: number; run_s: number; query: string | null }>(rows)
    .map((r) => ({ pid: Number(r.pid), state: r.state, idleS: Number(r.idle_s), runS: Number(r.run_s), table: queryTable(r.query) }));
}

export async function guardPool(cap = POOL_CAP, idleMinS = IDLE_MIN_S): Promise<PoolGuard> {
  const conns = await ownConns();
  const victims = pickVictims(conns, cap, idleMinS);
  let trimmed = 0;
  if (victims.length) {
    // Drizzle's sql`` spreads an array into separate parameters, so the list is written out; pids are integers read
    // from pg_stat_activity just above (checked again here).
    const pids = victims.map((v) => v.pid).filter((p) => Number.isInteger(p) && p > 0);
    const done = await db().execute(sql`select pg_terminate_backend(pid) as ok from unnest(array[${sql.raw(pids.join(","))}]::int[]) as pid`);
    trimmed = rowsOf<{ ok: boolean }>(done).filter((d) => d.ok).length;
  }
  const culprits = culpritText(victims);
  if (trimmed > 0) {
    console.info(`pool guard: ${conns.length + 1} connections, closed ${trimmed} (${culprits.join(", ")})`);
    await recordAction({ kind: "ok", message: `Pool guard: closed ${trimmed} of ${conns.length + 1} database connections`, detail: culprits.join(", ").slice(0, 300), resourceId: null, actorUserId: null })
      .catch(() => undefined);
  }
  return { total: conns.length + 1, trimmed, culprits };
}

// For the Supabase page (owner 16 Oct: "show what % it is and see what the culprit is"): Watchbell's own pooler
// connections, each with its state, how long it has been idle and the table its last query touched (never the query
// text or values). Null on error.
export type PoolConn = { busy: boolean; idleS: number; table: string | null; ageS: number };
export type PoolUsage = { used: number; active: number; conns: PoolConn[] };

// Pure: the ops table a query read or wrote ("ops"."monitors" → monitors), or null.
export function queryTable(q: string | null): string | null {
  const m = /(?:from|into|update|join)\s+"?ops"?\."?([a-z_]+)"?/i.exec(q ?? "");
  return m ? m[1] : null;
}

export async function poolUsage(): Promise<PoolUsage | null> {
  try {
    const rows = await db().execute(sql`
      select state, extract(epoch from now() - state_change)::int as idle_s, extract(epoch from now() - backend_start)::int as age_s,
        left(query, 400) as query
      from pg_stat_activity where usename = current_user and pid <> pg_backend_pid()
      order by state_change asc limit 20`);
    const list = rowsOf<{ state: string | null; idle_s: number; age_s: number; query: string | null }>(rows);
    const conns = list.map((r) => ({ busy: r.state !== "idle", idleS: Number(r.idle_s), table: queryTable(r.query), ageS: Number(r.age_s) }));
    // + this page's own connection
    return { used: conns.length + 1, active: conns.filter((c) => c.busy).length + 1, conns };
  } catch {
    return null;
  }
}

// Pure: the card's numbers. pct of the 15 slots; "warn" from the cap (10) on.
export const poolView = (u: { used: number; active: number }) => ({
  pct: Math.min(100, Math.round((u.used / POOL_SLOTS) * 100)),
  warn: u.used >= POOL_CAP,
});
