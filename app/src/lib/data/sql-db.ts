import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { resources, snapshots } from "@/db/schema";
import { sqlConnections } from "@/db/sql-schema";
import { openOrNull, seal } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { parseDsn, type SqlProvider } from "@/lib/sql/dsn";
import { sqlFingerprint } from "@/lib/sql/guard";
import { connectPg } from "@/lib/sql/pg-driver";
import { type Connect, type RunResult, runReadOnly, verifyReadOnly } from "@/lib/sql/run";
import { endpointBelongs, needsWakeConfirm, WAKE_TEXT, type WakeState, neonWakeState } from "@/lib/sql/targets";
import { dbAlias } from "@/lib/view/display-name";
import { aliasBook } from "./cached";
import type { Done } from "./monitors-db";

// Stage 9 slice 2: the owner's read-only SQL connections and the console's runs (server actions in
// app/(console)/sql/actions.ts check the role, the guard and the quota first). The connection string is sealed at
// rest, opened only for one run or the save test, and never returned to a page, a log line, an error or the audit.

const KINDS = { supabase_project: "supabase", neon_project: "neon" } as const;
type SqlKind = keyof typeof KINDS;
const SQL_KINDS: SqlKind[] = ["supabase_project", "neon_project"];
const isSqlKind = (k: string): k is SqlKind => k in KINDS;
const INVALID: Done = { ok: false, error: "Something in that request wasn't valid." };
const GONE = "That database is no longer watched.";

export type SqlDeps = { connect: Connect; alias: (id: string) => Promise<string>; key: () => string; now: () => Date };
export const sqlDefaults: SqlDeps = {
  connect: connectPg,
  alias: async (id) => dbAlias(await aliasBook(), id),
  key: () => serverEnv().OPS_ENCRYPTION_KEY,
  now: () => new Date(),
};

export async function watched(resourceId: string) {
  const [r] = await db().select({ id: resources.id, kind: resources.kind, externalId: resources.externalId, data: snapshots.data, state: snapshots.state })
    .from(resources).leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.id, resourceId), inArray(resources.kind, SQL_KINDS), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(1);
  return r && isSqlKind(r.kind) ? { ...r, provider: KINDS[r.kind] as SqlProvider } : null;
}

export type SaveDone = Done | { ok: false; error: string; needsWake: true };

// Saves (or replaces) the connection after one test: it must connect, BEGIN READ ONLY must hold, and the role must
// not be able to write. Anything else is refused and nothing is stored.
export async function saveSqlConnection(resourceId: string, raw: string, confirmWake: boolean, actorUserId: string, deps: SqlDeps = sqlDefaults): Promise<SaveDone> {
  if (!isUuid(resourceId) || typeof raw !== "string") return INVALID;
  const r = await watched(resourceId);
  if (!r) return { ok: false, error: GONE };
  const parsed = parseDsn(raw, r.provider, r.provider === "supabase" ? r.externalId : undefined);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (r.provider === "supabase" && r.state === "paused") return { ok: false, error: "This project is paused. Restore it first, then add SQL access." };
  if (r.provider === "neon") {
    if (!endpointBelongs(r.data, parsed.endpointId)) return { ok: false, error: "That string's endpoint isn't one of this Neon project's computes." };
    if (!confirmWake && needsWakeConfirm("neon", r.data, parsed.endpointId)) return { ok: false, error: `Saving tests the connection once. ${WAKE_TEXT}`, needsWake: true };
  }
  const test = await verifyReadOnly(parsed.dsn, deps);
  if (!test.ok) return { ok: false, error: test.error };
  const sealed = seal(raw.trim(), deps.key());
  const now = deps.now();
  const set = {
    provider: r.provider, dsnCiphertext: sealed.ciphertext, dsnIv: sealed.iv, keyVersion: sealed.keyVersion,
    roleName: parsed.role.slice(0, 63), endpointId: parsed.endpointId, addedBy: actorUserId, verifiedAt: now, updatedAt: now,
  };
  await db().insert(sqlConnections).values({ resourceId, ...set }).onConflictDoUpdate({ target: sqlConnections.resourceId, set });
  const alias = await deps.alias(resourceId);
  return { ok: true, message: `SQL access saved for ${alias}: read-only role ${parsed.role} checked.`, audit: { message: `SQL access saved · ${alias}`, resourceId } };
}

export async function removeSqlConnection(resourceId: string, deps: Pick<SqlDeps, "alias"> = sqlDefaults): Promise<Done> {
  if (!isUuid(resourceId)) return INVALID;
  const gone = await db().delete(sqlConnections).where(eq(sqlConnections.resourceId, resourceId)).returning({ id: sqlConnections.resourceId });
  if (!gone.length) return { ok: false, error: "This database has no SQL access." };
  const alias = await deps.alias(resourceId);
  return { ok: true, message: `SQL access removed for ${alias}. Drop the role in the database too.`, audit: { message: `SQL access removed · ${alias}`, resourceId } };
}

// ---- runs ----

export type RunAudit = { message: string; detail: string; kind: "ok" | "err"; resourceId: string };
export type RunDone =
  | { ok: true; result: Extract<RunResult, { ok: true }>; audit: RunAudit }
  | { ok: false; error: string; needsWake?: true; audit?: RunAudit };

// The audit line for one run: the alias, a 12-hex fingerprint of the query's shape (never its text), the duration and
// the row count. Pure, so a test can pin that nothing else gets in.
export function runAudit(alias: string, resourceId: string, text: string, r: RunResult): RunAudit {
  const fp = sqlFingerprint(text);
  if (r.ok) {
    return {
      kind: "ok", resourceId,
      message: `SQL run · ${alias} · ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? " (truncated)" : ""} · ${r.durationMs} ms`,
      detail: `fingerprint ${fp}`,
    };
  }
  return { kind: "err", resourceId, message: `SQL run failed · ${alias}${r.durationMs != null ? ` · ${r.durationMs} ms` : ""}`, detail: `fingerprint ${fp}` };
}

// `text` must already have passed guardSql. `admit` (the action's rate limit) runs only once the run will really
// connect, so a refusal or a wake prompt doesn't use up one of the owner's runs.
export async function runSql(resourceId: string, text: string, confirmWake: boolean, admit: () => Promise<string | null>, deps: SqlDeps = sqlDefaults): Promise<RunDone> {
  if (!isUuid(resourceId)) return { ok: false, error: "Something in that request wasn't valid." };
  const r = await watched(resourceId);
  if (!r) return { ok: false, error: GONE };
  const [c] = await db().select({ ciphertext: sqlConnections.dsnCiphertext, iv: sqlConnections.dsnIv, endpointId: sqlConnections.endpointId })
    .from(sqlConnections).where(eq(sqlConnections.resourceId, resourceId)).limit(1);
  if (!c) return { ok: false, error: "This database has no SQL access yet. Add it on its Databases row." };
  if (r.provider === "supabase" && r.state === "paused") return { ok: false, error: "This project is paused. Restore it first." };
  if (!confirmWake && needsWakeConfirm(r.provider, r.data, c.endpointId)) return { ok: false, error: WAKE_TEXT, needsWake: true };
  const plain = openOrNull({ ciphertext: c.ciphertext, iv: c.iv }, deps.key());
  const parsed = plain ? parseDsn(plain, r.provider, r.provider === "supabase" ? r.externalId : undefined) : null;
  if (!parsed?.ok) return { ok: false, error: "The stored connection string can't be read. Replace it." };
  const refused = await admit();
  if (refused) return { ok: false, error: refused };
  const result = await runReadOnly(parsed.dsn, text, deps);
  const alias = await deps.alias(resourceId);
  try {
    await db().update(sqlConnections).set({ lastRunAt: deps.now() }).where(eq(sqlConnections.resourceId, resourceId));
  } catch {
    console.warn("sql: last run time not saved");
  }
  const audit = runAudit(alias, resourceId, text, result);
  return result.ok ? { ok: true, result, audit } : { ok: false, error: result.error, audit };
}

// ---- the page ----

export type SqlTarget = {
  id: string; alias: string; provider: SqlProvider; connected: boolean; role: string | null;
  verifiedAt: Date | null; lastRunAt: Date | null; wake: WakeState | null; paused: boolean;
};

// Every watched Supabase and Neon database, with whether it has SQL access (no secret column is selected) and, for
// Neon, the compute state the wake prompt uses.
export async function sqlTargets(): Promise<SqlTarget[]> {
  const rows = await db().select({
    id: resources.id, kind: resources.kind, data: snapshots.data, state: snapshots.state,
    role: sqlConnections.roleName, endpointId: sqlConnections.endpointId, verifiedAt: sqlConnections.verifiedAt, lastRunAt: sqlConnections.lastRunAt,
  }).from(resources)
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .leftJoin(sqlConnections, eq(sqlConnections.resourceId, resources.id))
    .where(and(inArray(resources.kind, SQL_KINDS), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(200);
  const book = await aliasBook();
  return rows.filter((r) => isSqlKind(r.kind)).map((r) => {
    const provider = KINDS[r.kind as SqlKind];
    return {
      id: r.id, alias: dbAlias(book, r.id), provider, connected: r.verifiedAt !== null, role: r.role ?? null,
      verifiedAt: r.verifiedAt ?? null, lastRunAt: r.lastRunAt ?? null,
      wake: provider === "neon" ? neonWakeState(r.data, r.endpointId ?? null) : null, paused: r.state === "paused",
    };
  }).sort((a, b) => a.alias.localeCompare(b.alias, "en", { numeric: true }));
}

// For the Supabase and Neon pages: which of these databases have SQL access (ids only).
export async function sqlConnectedIds(resourceIds: string[]): Promise<Set<string>> {
  const ids = resourceIds.filter(isUuid);
  if (!ids.length) return new Set();
  const rows = await db().select({ id: sqlConnections.resourceId }).from(sqlConnections).where(inArray(sqlConnections.resourceId, ids)).limit(ids.length);
  return new Set(rows.map((r) => r.id));
}
