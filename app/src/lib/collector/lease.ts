import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { LEASE_MS } from "./schedule";

// One collector at a time. The app talks to Postgres through the transaction pooler, where session-level
// advisory locks are unsafe, so the lock is a lease row in ops.settings taken with one atomic upsert.
// db().execute() returns an array with postgres.js and { rows } with PGlite: rowsOf() reads the row count either way.
// The lease carries a random owner id, so a run that overran its lease can't release the lease of the run that took over.
export async function acquireLease(now = new Date()): Promise<string | null> {
  const owner = randomUUID();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const res = await db().execute(sql`
    insert into ops.settings (key, value) values ('collector.lease', ${JSON.stringify({ until, owner })}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (ops.settings.value->>'until')::timestamptz < ${now.toISOString()}::timestamptz
    returning key`);
  return rowsOf(res).length > 0 ? owner : null;
}

export async function releaseLease(owner: string): Promise<void> {
  await db().execute(sql`
    update ops.settings set value = jsonb_build_object('until', '1970-01-01T00:00:00Z'), updated_at = now()
    where key = 'collector.lease' and value->>'owner' = ${owner}`);
}
