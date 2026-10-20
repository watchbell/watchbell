import "server-only";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { createRequests } from "@/db/create-schema";
import { accounts, settings } from "@/db/schema";
import { openOrNull, type Sealed } from "@/lib/crypto";
import { CREATE_GRANT_KEY } from "@/lib/create/google-connect";
import { type CreateRequestView, type CreateResult, type CreateType, summaryOf } from "@/lib/create/types";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";

// Stage 6 create requests: the table (0048 ops.create_requests). Status moves only forward, each step a compare-and-set
// on the status it expects: requested → approved | rejected | expired; approved → running (the claim: one process
// only, so a retried click can't create twice) → done | failed.

export type CreateRow = typeof createRequests.$inferSelect;
export type NewCreateRow = Pick<CreateRow, "type" | "provider" | "accountId" | "targetResourceId" | "targetLabel" | "inputs" | "requestedBy" | "expiresAt">;
const LIST_WINDOW_MS = 7 * 86_400_000;

export async function insertRequest(row: NewCreateRow): Promise<CreateRow> {
  const [r] = await db().insert(createRequests).values({ ...row, status: "requested" }).returning();
  return r;
}

export async function getRequest(id: string): Promise<CreateRow | null> {
  if (!isUuid(id)) return null;
  const [r] = await db().select().from(createRequests).where(eq(createRequests.id, id)).limit(1);
  return r ?? null;
}

// requested → approved | rejected, only while it hasn't expired.
export async function decideRequest(id: string, decision: "approve" | "reject", memberId: string, now: Date): Promise<CreateRow | null> {
  const [r] = await db().update(createRequests)
    .set({ status: decision === "approve" ? "approved" : "rejected", approvedBy: memberId, decidedAt: now })
    .where(and(eq(createRequests.id, id), eq(createRequests.status, "requested"), sql`${createRequests.expiresAt} > ${now.toISOString()}::timestamptz`))
    .returning();
  return r ?? null;
}

export async function claimRequest(id: string, now: Date): Promise<CreateRow | null> {
  const [r] = await db().update(createRequests).set({ status: "running", claimedAt: now })
    .where(and(eq(createRequests.id, id), eq(createRequests.status, "approved"))).returning();
  return r ?? null;
}

// running → done | failed. `result` holds ids and names only; `error` is our own sentence.
export async function finishRequest(id: string, p: { ok: boolean; result?: CreateResult | null; error?: string | null }, now: Date): Promise<void> {
  await db().update(createRequests)
    .set({ status: p.ok ? "done" : "failed", result: p.result ?? null, error: p.error ? p.error.slice(0, 300) : null, finishedAt: now })
    .where(and(eq(createRequests.id, id), eq(createRequests.status, "running")));
}

export async function expireRequests(now: Date): Promise<number> {
  const rows = await db().update(createRequests).set({ status: "expired" })
    .where(and(eq(createRequests.status, "requested"), lte(createRequests.expiresAt, now))).returning({ id: createRequests.id });
  return rows.length;
}

export function toView(r: CreateRow, viewerMemberId: string | null): CreateRequestView {
  const s = summaryOf(r.type, r.inputs);
  return {
    id: r.id, type: r.type, provider: r.provider, targetLabel: r.targetLabel, summary: s.summary, confirmName: s.confirmName,
    status: r.status, mine: viewerMemberId === r.requestedBy, result: r.result ?? null, error: r.error ?? null,
    createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
  };
}

// Waiting first, then newest; the last 7 days. Expired ones are marked on the way (no job needed).
export async function listRequests(viewerMemberId: string | null, types?: CreateType[], limit = 20): Promise<CreateRequestView[]> {
  const now = new Date();
  await expireRequests(now).catch(() => 0);
  const rows = await db().select().from(createRequests)
    .where(and(
      sql`${createRequests.createdAt} >= ${new Date(now.getTime() - LIST_WINDOW_MS).toISOString()}::timestamptz`,
      types?.length ? inArray(createRequests.type, types) : undefined,
    ))
    .orderBy(sql`case when ${createRequests.status} = 'requested' then 0 else 1 end`, desc(createRequests.createdAt))
    .limit(limit);
  return rows.map((r) => toView(r, viewerMemberId));
}

// ---- credentials (read-only uses; the token stays in the server action that asked for it) ----
export async function listAccounts(provider: "supabase" | "neon" | "cloudflare"): Promise<{ id: string; label: string }[]> {
  return db().select({ id: accounts.id, label: accounts.label }).from(accounts).where(eq(accounts.provider, provider)).orderBy(accounts.label);
}

export async function loadAccount(accountId: string, provider: "supabase"): Promise<{ id: string; label: string; token: string } | null> {
  if (!isUuid(accountId)) return null;
  const [a] = await db().select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.provider, provider))).limit(1);
  if (!a) return null;
  const token = openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return token ? { id: a.id, label: a.label, token } : null;
}

// The Owner's Google create grant (Firebase): sealed refresh token in ops.settings.
type Grant = Sealed & { connectedAt: string };
export async function saveCreateGrant(sealed: Sealed): Promise<void> {
  const value: Grant = { ...sealed, connectedAt: new Date().toISOString() };
  await db().insert(settings).values({ key: CREATE_GRANT_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function readCreateGrant(): Promise<{ refreshToken: string; connectedAt: string } | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, CREATE_GRANT_KEY)).limit(1);
  const v = row?.value as Partial<Grant> | undefined;
  if (!v || typeof v.ciphertext !== "string" || typeof v.iv !== "string") return null;
  const refreshToken = openOrNull({ ciphertext: v.ciphertext, iv: v.iv }, serverEnv().OPS_ENCRYPTION_KEY);
  return refreshToken ? { refreshToken, connectedAt: typeof v.connectedAt === "string" ? v.connectedAt : "" } : null;
}

export async function createGrantConnected(): Promise<string | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, CREATE_GRANT_KEY)).limit(1);
  const v = row?.value as Partial<Grant> | undefined;
  return v && typeof v.ciphertext === "string" ? (typeof v.connectedAt === "string" ? v.connectedAt : "") : null;
}

// Forgets the grant in the console only; nothing changes at Google (the Owner revokes it in the Google Account).
export async function removeCreateGrant(): Promise<void> {
  await db().delete(settings).where(eq(settings.key, CREATE_GRANT_KEY));
}
