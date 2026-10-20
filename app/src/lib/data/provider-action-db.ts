import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { db } from "@/db/client";
import { accounts, resources, settings } from "@/db/schema";
import type { ActionResult, GuardMember } from "@/lib/action";
import { openOrNull } from "@/lib/crypto";
import { recordAction } from "@/lib/data/audit-db";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { type ActionOutcome, cooldownText, shortDetail } from "@/lib/provider-actions";
import { LIMITS } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Stage 6 runner, the server half (plan Task 0). Every provider action: guard role → validate ids → targetQuota →
// loadTarget → read live state → write → finish. The decrypted token stays inside the server action that asked for it.

export type TargetKind = "app" | "supabase_project" | "neon_project" | "zone";
export type Target = {
  resource: typeof resources.$inferSelect;
  account: { id: string; label: string; provider: string; scopeNote: string | null };
  token: string;
};
// Who acts: a signed-in member (GuardMember fits), or the office auto-run (Stage 9: id "office-auto" keys the quotas,
// userId null leaves the audit row without an actor, like the other system actions).
export type Actor = Pick<GuardMember, "id"> & { userId: string | null };
export type WriteAccess ={ write: "ok" | "denied"; at: string; scope?: string };

const ACCESS_PREFIX = "access.";

// A watched or synced resource of that kind that the provider still returns, with its account's opened credential.
// Null when the id is unknown, the row is gone, or the credential can't be opened.
export async function loadTarget(resourceId: string, kind: TargetKind): Promise<Target | null> {
  if (!isUuid(resourceId)) return null;
  const [row] = await db().select({ r: resources, a: accounts }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(and(eq(resources.id, resourceId), eq(resources.kind, kind), isNull(resources.goneAt)))
    .limit(1);
  if (!row) return null;
  const token = openOrNull({ ciphertext: row.a.credentialCiphertext, iv: row.a.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  if (!token) return null;
  return { resource: row.r, account: { id: row.a.id, label: row.a.label, provider: row.a.provider, scopeNote: row.a.scopeNote }, token };
}

// A4: the member's quota first (all provider actions), then the per-target cooldown. Error text, or null to go on.
export async function targetQuota(memberId: string, action: string, resourceId: string): Promise<string | null> {
  const member = await limit(LIMITS.providerAction, memberId);
  if (!member.allowed) return cooldownText("member", member.retryAfter);
  const target = await limit(LIMITS.actionTarget, `${action}:${resourceId}`);
  return target.allowed ? null : cooldownText("target", target.retryAfter);
}

// A6: the last write attempt's outcome per account, for the Connections Access hint.
export async function setWriteAccess(accountId: string, write: "ok" | "denied", scope?: string): Promise<void> {
  const value: WriteAccess = { write, at: new Date().toISOString(), ...(scope ? { scope } : {}) };
  await db().insert(settings).values({ key: `${ACCESS_PREFIX}${accountId}`, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function writeAccess(accountIds: string[]): Promise<Map<string, WriteAccess>> {
  const out = new Map<string, WriteAccess>();
  const ids = accountIds.filter(isUuid);
  if (ids.length === 0) return out;
  const rows = await db().select().from(settings).where(inArray(settings.key, ids.map((id) => `${ACCESS_PREFIX}${id}`)));
  for (const row of rows) {
    const v = row.value as Partial<WriteAccess> | null;
    if (v && (v.write === "ok" || v.write === "denied") && typeof v.at === "string") {
      out.set(row.key.slice(ACCESS_PREFIX.length), { write: v.write, at: v.at, ...(typeof v.scope === "string" ? { scope: v.scope } : {}) });
    }
  }
  return out;
}

// A5/A6: audit what reached the provider, remember whether the account can write, and re-render the page. The action
// already happened, so a failed audit or access write is logged and doesn't change the answer.
// Stage 9: outside a server action (an office approval in a route handler, the auto-run in the minute step) there is no
// page to re-render (next/cache refresh() only works in server actions); an auto-run's audit names itself in its message.
// What a shared action core calls to audit its outcome: finish itself, or finish with FinishOpts bound.
export type Finisher = (o: ActionOutcome, actor: Actor, accountId: string) => Promise<ActionResult>;
export type FinishOpts = { refresh?: boolean; auditPrefix?: string };
export async function finish(o: ActionOutcome, member: Actor, accountId: string, opts: FinishOpts = {}): Promise<ActionResult> {
  if (!("audit" in o)) return { ok: false, error: o.message };
  const failed = "failed" in o ? o.failed : null;
  const message = "failed" in o ? "" : o.message;
  const detail = failed ? failed.error : "failed" in o ? undefined : o.audit.detail;
  try {
    await recordAction({
      kind: failed ? "err" : "ok", message: `${opts.auditPrefix ?? ""}${o.audit.message}`, resourceId: o.audit.resourceId, actorUserId: member.userId,
      ...(detail ? { detail: shortDetail(detail) } : {}),
    });
  } catch {
    console.warn("audit event failed");
  }
  if (!failed || failed.kind === "scope") {
    try {
      await setWriteAccess(accountId, failed ? "denied" : "ok");
    } catch {
      console.warn("access write failed");
    }
  }
  if (opts.refresh !== false) refresh();
  return failed ? { ok: false, error: failed.error } : { ok: true, message };
}
