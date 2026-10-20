import "server-only";
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { recordEvents } from "@/lib/data/events-write";
import { windowStart } from "@/lib/rate-limit";
import { aiAgents, aiProviders, apiKeys } from "@/private/db/schema";
import { newApiKey, type KeyFormValues, expiryDate } from "./key";
import { MAX_ACTIVE_KEYS, SCOPES, type Scope } from "./scopes";

// Console API keys, server side. Only a sha256 hash of a key is ever stored or passed around (R3); nothing here logs a
// key, a hash or a statement's parameters.

export type KeyRow = {
  id: string; name: string; prefix: string; scopes: Scope[]; ratePerMin: number; providerId: string | null; model: string | null;
  expiresAt: Date | null; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; createdBy: string;
  clients: string[]; // detected clients (ai_agents.client_name) that used this key
};

export class KeyLimitError extends Error {
  constructor() { super("key-limit"); }
}
export class KeyNameTakenError extends Error {
  constructor() { super("name-taken"); }
}
export class KeyNotFoundError extends Error {
  constructor() { super("not-found"); }
}

const asScopes = (v: unknown): Scope[] => (Array.isArray(v) ? v.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)) : []);

// postgres.js errors carry the SQLSTATE in `code`; drizzle wraps them in `cause`.
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

// An audit row (spec §12) never carries the key or its hash: name and prefix only. A failed audit must not undo or hide
// the change itself, so it only warns.
async function audit(reason: "ApiKeyCreated" | "ApiKeyRevoked" | "ApiKeyChanged", message: string, detail: string | null, by: string): Promise<void> {
  try {
    await recordEvents([{ type: "action", kind: "ok", message, detail, resourceId: null, actorUserId: by, reason }]);
  } catch {
    console.warn("api key audit failed");
  }
}

// R7: serialises key creation so two owners can't both squeeze in the 21st key. Same lock pattern as the members page.
const KEYS_LOCK = 7_412_005;

export async function createKey(values: KeyFormValues, by: string, now: Date = new Date()): Promise<{ key: string; row: KeyRow }> {
  const made = newApiKey();
  const expiresAt = expiryDate(values.expiry, now);
  const [row] = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${KEYS_LOCK})`);
    const active = await tx.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys)
      .where(and(isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))))
      .limit(MAX_ACTIVE_KEYS + 1);
    if (active.length >= MAX_ACTIVE_KEYS) throw new KeyLimitError();
    // The unique index covers keys that aren't revoked (expired ones too), so check the same set.
    const taken = await tx.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.name, values.name), isNull(apiKeys.revokedAt))).limit(1);
    if (taken.length) throw new KeyNameTakenError();
    return tx.insert(apiKeys).values({
      name: values.name, prefix: made.prefix, keyHash: made.hash, scopes: values.scopes, ratePerMin: values.ratePerMin,
      expiresAt, createdBy: by,
    }).returning();
  });
  await audit("ApiKeyCreated", `API key created: ${row.name} (${row.prefix})`, `scopes ${values.scopes.join(", ")}; ${row.ratePerMin}/min`, by);
  return { key: made.key, row: { ...row, scopes: asScopes(row.scopes), clients: [] } };
}

export async function listKeys(): Promise<KeyRow[]> {
  const [keys, agents] = await Promise.all([
    db().select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).limit(200),
    db().select({ keyId: aiAgents.keyId, name: aiAgents.clientName }).from(aiAgents).where(isNotNull(aiAgents.keyId)).orderBy(asc(aiAgents.firstSeenAt)).limit(2000),
  ]);
  const byKey = new Map<string, string[]>();
  for (const a of agents) if (a.keyId) byKey.set(a.keyId, [...(byKey.get(a.keyId) ?? []), a.name]);
  return keys.map((k) => ({ ...k, scopes: asScopes(k.scopes), clients: byKey.get(k.id) ?? [] }));
}

export async function revokeKey(id: string, by: string, now: Date = new Date()): Promise<void> {
  const [row] = await db().update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ name: apiKeys.name, prefix: apiKeys.prefix });
  if (!row) throw new KeyNotFoundError();
  await audit("ApiKeyRevoked", `API key revoked: ${row.name} (${row.prefix})`, null, by);
}

export type KeyPatch = { name?: string; ratePerMin?: number; expiresAt?: Date | null; providerId?: string | null; model?: string | null };

// Rename, rate limit, expiry, routing pin. A revoked key can't be changed (it is gone for good).
export async function updateKey(id: string, patch: KeyPatch, by: string): Promise<void> {
  const set: Partial<typeof apiKeys.$inferInsert> = {};
  const changed: string[] = [];
  if (patch.name !== undefined) { set.name = patch.name; changed.push("name"); }
  if (patch.ratePerMin !== undefined) { set.ratePerMin = patch.ratePerMin; changed.push(`rate ${patch.ratePerMin}/min`); }
  if (patch.expiresAt !== undefined) { set.expiresAt = patch.expiresAt; changed.push(patch.expiresAt ? "expiry" : "no expiry"); }
  if (patch.providerId !== undefined) { set.providerId = patch.providerId; changed.push("routing"); }
  if (patch.model !== undefined) { set.model = patch.model; if (!changed.includes("routing")) changed.push("routing"); }
  if (!changed.length) return;
  let row: { name: string; prefix: string } | undefined;
  try {
    [row] = await db().update(apiKeys).set(set).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning({ name: apiKeys.name, prefix: apiKeys.prefix });
  } catch (e) {
    if (isUniqueViolation(e)) throw new KeyNameTakenError();
    throw e;
  }
  if (!row) throw new KeyNotFoundError();
  await audit("ApiKeyChanged", `API key changed: ${row.name} (${row.prefix})`, changed.join(", "), by);
}

export type ProviderOption = { id: string; name: string; enabled: boolean };

// The Change routing select. Its own small read, so this task doesn't wait for the provider task.
export async function listProviderOptions(): Promise<ProviderOption[]> {
  return db().select({ id: aiProviders.id, name: aiProviders.name, enabled: aiProviders.enabled }).from(aiProviders).orderBy(asc(aiProviders.name)).limit(20);
}

// What `/me` shows besides the context: when the key stops working. One read by id.
export async function keyExpiry(id: string): Promise<Date | null> {
  const [row] = await db().select({ expiresAt: apiKeys.expiresAt }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return row?.expiresAt ? new Date(row.expiresAt) : null;
}

export type AuthRow = {
  id: string; name: string; prefix: string; scopes: Scope[]; ratePerMin: number; providerId: string | null; model: string | null;
  hits: number; // this minute's calls with this key, counting this one
};

// The hot path's one statement before the work: the active, unexpired key for this hash AND this minute's hit on its
// `apikey:<id>` counter (ops.rate_limits, 60 s window), in one CTE. The first hit of a window also sweeps counters older
// than a day, like the other limiters do. No row means unknown, revoked or expired: the caller answers 401.
// (drizzle's postgres-js driver hands timestamps back as text, so none are selected: the filter runs in SQL.)
export async function authLookup(hash: string, now: Date): Promise<AuthRow | null> {
  const nowIso = now.toISOString();
  const windowIso = windowStart(now, 60).toISOString();
  const sweepIso = new Date(now.getTime() - 86_400_000).toISOString();
  const res = await db().execute(sql`
    with k as (
      select id, name, prefix, scopes, rate_per_min, provider_id, model
      from ops.api_keys
      where key_hash = ${hash} and revoked_at is null and (expires_at is null or expires_at > ${nowIso}::timestamptz)
    ),
    hit as (
      insert into ops.rate_limits (key, window_start, count)
      select 'apikey:' || k.id::text, ${windowIso}::timestamptz, 1 from k
      on conflict (key, window_start) do update set count = ops.rate_limits.count + 1
      returning count
    ),
    sweep as (
      delete from ops.rate_limits where (select hit.count from hit) = 1 and window_start < ${sweepIso}::timestamptz
    )
    select k.id, k.name, k.prefix, k.scopes, k.rate_per_min, k.provider_id, k.model, hit.count as hits from k, hit
  `);
  const r = rowsOf<{
    id: string; name: string; prefix: string; scopes: string[]; rate_per_min: number; provider_id: string | null; model: string | null; hits: number | string;
  }>(res)[0];
  if (!r) return null;
  return {
    id: r.id, name: r.name, prefix: r.prefix, scopes: asScopes(r.scopes), ratePerMin: Number(r.rate_per_min),
    providerId: r.provider_id, model: r.model, hits: Number(r.hits),
  };
}
