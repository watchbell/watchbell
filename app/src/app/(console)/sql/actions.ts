"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { firestoreCollections, queryFirestore } from "@/lib/data/firestore-query-db";
import { targetQuota } from "@/lib/data/provider-action-db";
import { createSqlAccessAuto, sqlAutoStatus } from "@/lib/data/sql-auto-db";
import type { Done } from "@/lib/data/monitors-db";
import { type RunAudit, removeSqlConnection, runSql, saveSqlConnection } from "@/lib/data/sql-db";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";
import type { FsRun } from "@/lib/providers/firestore-query";
import type { AutoAccess } from "@/lib/providers/supabase-sql";
import { type Limit, LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { guardSql } from "@/lib/sql/guard";
import type { RunOk } from "@/lib/sql/run";

// Stage 9 slice 2: the SQL console and the Firestore query builder, owner only. Every export is a public endpoint, so
// each re-checks the role and every argument on the server: the statement guard runs before anything else, the rate
// limit (20 runs per 10 minutes) only once a run will really connect, and every run is audited with the database
// alias and a fingerprint, never the query text or the connection string.
const deps = { requireActionMember };

export type SqlRunData = { run?: Omit<RunOk, "ok">; needsWake?: true };
export type FsRunData = { run?: FsRun & { durationMs: number }; collections?: string[]; more?: boolean };

async function audit(a: RunAudit | undefined, member: GuardMember): Promise<void> {
  if (!a) return;
  try {
    await recordAction({ kind: a.kind, message: a.message, detail: a.detail, resourceId: a.resourceId, actorUserId: member.userId });
  } catch {
    console.warn("audit event failed");
  }
}

const admitFor = (l: Limit, member: GuardMember, what: string) => async (): Promise<string | null> => {
  const q = await limit(l, member.id);
  return q.allowed ? null : `Too many ${what}. Try again in ${minutesText(q.retryAfter)}.`;
};

export async function runSqlAction(resourceId: string, text: string, confirmWake: boolean): Promise<ActionResult<SqlRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<SqlRunData>> => {
    if (!isUuid(resourceId) || typeof confirmWake !== "boolean") return { ok: false, error: INVALID };
    const g = guardSql(text);
    if (!g.ok) return { ok: false, error: g.error, fieldErrors: { sql: g.error } };
    const r = await runSql(resourceId, g.text, confirmWake, admitFor(LIMITS.sqlRun, member, "runs"));
    await audit(r.audit, member);
    if (!r.ok) return { ok: false, error: r.error, ...(r.needsWake ? { data: { needsWake: true as const } } : {}) };
    const { columns, rows, rowCount, truncated, durationMs } = r.result;
    return { ok: true, data: { run: { columns, rows, rowCount, truncated, durationMs } } };
  }, deps);
}

async function done(r: Done | { ok: false; error: string; needsWake?: true }, member: GuardMember): Promise<ActionResult<SqlRunData>> {
  if (!r.ok) return { ok: false, error: r.error, ...("needsWake" in r && r.needsWake ? { data: { needsWake: true as const } } : {}) };
  if (r.audit) {
    try {
      await recordAction({ kind: "ok", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
  }
  refresh();
  return { ok: true, message: r.message };
}

export async function setSqlAccess(resourceId: string, connectionString: string, confirmWake: boolean): Promise<ActionResult<SqlRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<SqlRunData>> => {
    if (!isUuid(resourceId) || typeof connectionString !== "string" || typeof confirmWake !== "boolean") return { ok: false, error: INVALID };
    if (!connectionString.trim()) return { ok: false, error: "Paste a connection string.", fieldErrors: { dsn: "Paste a connection string." } };
    // The save test opens a real connection, so it shares the credential-test quota.
    const refused = await admitFor(LIMITS.credential, member, "connection tests")();
    if (refused) return { ok: false, error: refused };
    return done(await saveSqlConnection(resourceId, connectionString, confirmWake, member.userId), member);
  }, deps);
}

// Stage 9 slice 2b: whether this Supabase project's token can run "Set up automatically" (two read-only API calls). It
// talks to Supabase, so it shares the credential-test quota.
export async function sqlAutoStatusAction(resourceId: string): Promise<ActionResult<AutoAccess>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AutoAccess>> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    const refused = await admitFor(LIMITS.credential, member, "connection tests")();
    if (refused) return { ok: false, error: refused };
    return { ok: true, data: await sqlAutoStatus(resourceId) };
  }, deps);
}

// Stage 9 slice 2b: "Set up automatically (read-only)": creates or resets the watchpost_ro role through the Management API,
// checks it with the save-time read-only test and saves it sealed. A provider write, so it takes the provider-action
// quota and the per-target cooldown; every attempt that reached the database is audited. The password never comes back.
export async function createSqlAccessAutoAction(resourceId: string): Promise<ActionResult<SqlRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<SqlRunData>> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    const refused = await targetQuota(member.id, "sql-auto", resourceId);
    if (refused) return { ok: false, error: refused };
    const r = await createSqlAccessAuto(resourceId, member.userId);
    if (r.audit) {
      try {
        await recordAction({ kind: r.audit.kind, message: r.audit.message, resourceId: r.audit.resourceId, actorUserId: member.userId });
      } catch {
        console.warn("audit event failed");
      }
    }
    if (!r.ok) return { ok: false, error: r.error };
    refresh();
    return { ok: true, message: r.message };
  }, deps);
}

export async function deleteSqlAccess(resourceId: string): Promise<ActionResult<SqlRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<SqlRunData>> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    const refused = await admitFor(LIMITS.monitorWrite, member, "changes")();
    if (refused) return { ok: false, error: refused };
    return done(await removeSqlConnection(resourceId), member);
  }, deps);
}

export async function firestoreCollectionsAction(resourceId: string): Promise<ActionResult<FsRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<FsRunData>> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    // Listing collections is billed as one read, so it shares the query quota.
    const refused = await admitFor(LIMITS.firestoreQuery, member, "Firestore queries")();
    if (refused) return { ok: false, error: refused };
    const r = await firestoreCollections(resourceId);
    return r.ok ? { ok: true, data: { collections: r.ids, more: r.more } } : { ok: false, error: r.error };
  }, deps);
}

export async function firestoreQueryAction(resourceId: string, query: unknown): Promise<ActionResult<FsRunData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<FsRunData>> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    const r = await queryFirestore(resourceId, query, admitFor(LIMITS.firestoreQuery, member, "Firestore queries"));
    await audit(r.audit, member);
    return r.ok ? { ok: true, data: { run: r.result } } : { ok: false, error: r.error };
  }, deps);
}
