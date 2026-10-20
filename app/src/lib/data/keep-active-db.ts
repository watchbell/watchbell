import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, events, keepActive, resources, snapshots } from "@/db/schema";
import { openOrNull } from "@/lib/crypto";
import { recordEvents } from "@/lib/data/events-write";
import type { ActionResult } from "@/lib/action";
import { type Actor, finish, type Finisher, loadTarget, setWriteAccess, targetQuota, writeAccess } from "@/lib/data/provider-action-db";
import { autoRestoreDecision, keepAliveDue, PAUSE_REQUESTED } from "@/lib/databases/keep-active";
import { readData, supabaseData } from "@/lib/databases/snapshot-data";
import { freeSlots, PAUSE_AFTER_DAYS } from "@/lib/databases/supabase";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { scopeMessage, shortDetail } from "@/lib/provider-actions";
import { keepAlive, restoreProject } from "@/lib/providers/supabase";
import type { Done } from "./monitors-db";

// Stage 6 A8: the owner's Keep active and Auto-restore rows, the daily keep-alive and the status task's auto-restore.
// System actions: their events carry no actor (actorUserId null) and start with "Keep-alive:" / "Auto-restore:".
// Neither ever pauses a project, and neither runs for anything but a watched Supabase project.

const DAY = 86_400_000;
const CALL_MS = 5_000;
// The daily job runs once a day; a re-run the same day (manual or retried) doesn't send a second keep-alive.
const KEEP_ALIVE_MIN_GAP_MS = 20 * 3600_000;

export type Flags = { keep: boolean; autoRestore: boolean; lastKeepAliveAt: Date | null };

export async function keepActiveFlags(resourceIds: string[]): Promise<Map<string, Flags>> {
  const ids = resourceIds.filter(isUuid);
  const out = new Map<string, Flags>();
  if (!ids.length) return out;
  const rows = await db().select().from(keepActive).where(inArray(keepActive.resourceId, ids));
  for (const r of rows) out.set(r.resourceId, { keep: r.keep, autoRestore: r.autoRestore, lastKeepAliveAt: r.lastKeepAliveAt });
  return out;
}

const SAVED: Record<"keep" | "autoRestore", (name: string, on: boolean) => string> = {
  keep: (n, on) => (on ? `${n}: warning from day 5 without API traffic, and one keep-alive query a day.` : `${n} may pause after 7 idle days.`),
  autoRestore: (n, on) => (on ? `${n} is restored automatically when its account has a free slot.` : `${n} is no longer restored automatically.`),
};
const AUDIT: Record<"keep" | "autoRestore", string> = { keep: "Keep active", autoRestore: "Auto-restore" };

// Owner only (the server action checks). Ticking a box again also clears a stopped Auto-restore (A8: a 403 stops it
// until the credential is replaced or the owner re-ticks), because `updated_at` moves past the denied write.
export async function setFlag(resourceId: string, field: "keep" | "autoRestore", on: boolean, actorUserId: string): Promise<Done> {
  const [r] = await db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.kind, "supabase_project"), isNull(resources.goneAt))).limit(1);
  if (!r) return { ok: false, error: "That Supabase project is no longer watched." };
  const now = new Date();
  const set = { [field]: on, updatedBy: actorUserId, updatedAt: now };
  await db().insert(keepActive).values({ resourceId, ...set }).onConflictDoUpdate({ target: keepActive.resourceId, set });
  return { ok: true, message: SAVED[field](r.name, on), audit: { message: `${AUDIT[field]} ${on ? "on" : "off"} · ${r.name}`, resourceId } };
}

// The plan of each organization this account's projects belong to, as the hourly usage task last read it (D3).
export async function accountPlans(accountId: string): Promise<Map<string, boolean | null>> {
  const rows = await db().select({ data: snapshots.data }).from(resources)
    .innerJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.accountId, accountId), eq(resources.kind, "supabase_project")));
  const out = new Map<string, boolean | null>();
  for (const { data } of rows) {
    const d = readData(supabaseData, data);
    if (d.orgSlug && d.freeOrg !== undefined) out.set(d.orgSlug, d.freeOrg);
  }
  return out;
}

// Free slots left for one account from a fresh project list (D3: free orgs only, an unknown plan counts as free).
// A project in a paid org needs no free slot.
export function slotsLeft(projects: { status: string; orgSlug: string }[], plans: Map<string, boolean | null>, targetOrg: string): number {
  if (plans.get(targetOrg) === false) return Number.POSITIVE_INFINITY;
  return freeSlots(projects.map((p) => ({ status: p.status, freeOrg: plans.get(p.orgSlug) ?? null }))).left;
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const safe = (e: unknown) => (e instanceof Error ? e.name : "unknown");

// Daily step "keep-active" (A8): one `select 1` for each kept, active healthy project without API traffic for 5 days.
// Never throws into the daily job: a failure is one short line in `errors`.
export async function runKeepAlive(now: Date, deadline: number, errors: string[]): Promise<void> {
  try {
    const rows = await db().select({ k: keepActive, r: resources, s: snapshots, a: accounts }).from(keepActive)
      .innerJoin(resources, eq(resources.id, keepActive.resourceId))
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
      .where(and(eq(keepActive.keep, true), eq(resources.kind, "supabase_project"), eq(resources.monitored, true), isNull(resources.goneAt), eq(accounts.status, "ok")))
      .limit(100);
    const key = serverEnv().OPS_ENCRYPTION_KEY;
    for (const [i, { k, r, s, a }] of rows.entries()) {
      const left = deadline - Date.now() - 500;
      if (left < 250) {
        errors.push(`keep-active: ${rows.length - i} left for the next run, time budget used`);
        return;
      }
      if (k.lastKeepAliveAt && now.getTime() - k.lastKeepAliveAt.getTime() < KEEP_ALIVE_MIN_GAP_MS) continue;
      // M9: one project's database error is one line; the projects after it still get their keep-alive.
      try {
        await keepAliveOne(r, s, a, now, key, left, errors);
      } catch (e) {
        console.warn("keep-active failed:", safe(e));
        errors.push(`keep-active/${r.name}: ${safe(e)}`);
      }
    }
  } catch (e) {
    console.warn("keep-active failed:", safe(e));
    errors.push(`keep-active: ${safe(e)}`);
  }
}

// One kept project: due? then the keep-alive, its stamp and its event.
type KeptRow = { r: typeof resources.$inferSelect; s: typeof snapshots.$inferSelect | null; a: typeof accounts.$inferSelect };

async function keepAliveOne(r: KeptRow["r"], s: KeptRow["s"], a: KeptRow["a"], now: Date, key: string, left: number, errors: string[]): Promise<void> {
  const d = readData(supabaseData, s?.data);
  // The hourly read covers 7 days: checked with no traffic at all means at least 7 idle days.
  const lastTraffic = d.lastTrafficAt ? new Date(d.lastTrafficAt) : d.trafficAt ? new Date(new Date(d.trafficAt).getTime() - 7 * DAY) : null;
  if (!keepAliveDue({ status: d.status ?? "", keep: true, lastTraffic, trackedSince: r.firstSeenAt }, now)) return;
  const idle = Math.floor((now.getTime() - (lastTraffic ?? r.firstSeenAt).getTime()) / DAY);
  const token = openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, key);
  if (!token) { errors.push(`keep-active/${a.label}: credential can't be read`); return; }
  const res = await keepAlive(token, r.externalId, { timeoutMs: Math.min(CALL_MS, left) });
  if (res.ok) {
    await db().update(keepActive).set({ lastKeepAliveAt: now }).where(eq(keepActive.resourceId, r.id));
    await recordEvents([{ at: now, type: "action", kind: "ok", resourceId: r.id, actorUserId: null, message: `Keep-alive: sent to ${r.name} (no API traffic for ${days(idle)})`, detail: null }]);
  } else {
    const inDays = Math.max(1, PAUSE_AFTER_DAYS - idle);
    await recordEvents([{
      at: now, type: "action", kind: "warn", resourceId: r.id, actorUserId: null, reason: "KeepAliveFailed",
      message: `Keep-alive failed for ${r.name}; it may pause in about ${days(inDays)}`,
      detail: res.kind === "scope" ? "This token can't run the read-only query (Database read)." : shortDetail(res.error),
    }]);
    errors.push(`keep-active/${r.name}: ${res.error}`);
  }
}

// When a member last paused this project through the console (its audit row), or null. A pause whose call timed out is
// audited with the same message and kind err (minor M7): it may still have happened, so it counts too.
async function lastConsolePause(resourceId: string): Promise<Date | null> {
  const [e] = await db().select({ at: events.at }).from(events)
    .where(and(eq(events.reason, "Action"), eq(events.resourceId, resourceId), eq(events.type, "action"), inArray(events.kind, ["ok", "err"]),
      isNotNull(events.actorUserId), like(events.message, `${PAUSE_REQUESTED}%`)))
    .orderBy(desc(events.at)).limit(1);
  return e?.at ?? null;
}

export type ProjectStatus = { resourceId: string | null; accountId: string; status: string; orgSlug?: string };

// The 5-minute Supabase status task calls this with the statuses it just read (A8). Every project the token sees is
// passed (resourceId null when the console doesn't watch it) so the free slots are counted from the fresh list. With
// nothing paused it reads nothing; otherwise one read of the paused projects that have Auto-restore on. `deadline` is
// the status task's: nothing starts once it is near, and a restore call never runs past it (the next run retries).
export async function autoRestoreHook(now: Date, statuses: ProjectStatus[], deadline = Number.POSITIVE_INFINITY): Promise<void> {
  const paused = statuses.filter((s): s is ProjectStatus & { resourceId: string } => !!s.resourceId && s.status === "INACTIVE");
  const timeLeft = () => deadline - Date.now() - 500;
  if (!paused.length || timeLeft() < 250) return;
  const rows = await db().select({
    k: keepActive, id: resources.id, name: resources.name, ref: resources.externalId, accountId: resources.accountId,
    label: accounts.label, lastTestAt: accounts.lastTestAt, ciphertext: accounts.credentialCiphertext, iv: accounts.credentialIv,
  }).from(keepActive)
    .innerJoin(resources, eq(resources.id, keepActive.resourceId))
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(and(eq(keepActive.autoRestore, true), inArray(keepActive.resourceId, paused.map((p) => p.resourceId)), eq(resources.kind, "supabase_project"), isNull(resources.goneAt)));
  if (!rows.length) return;
  const access = await writeAccess([...new Set(rows.map((r) => r.accountId))]);
  // Per account: its org plans and the free slots its free orgs share. A project in a paid org needs no slot, but that
  // must not lend unlimited slots to the account's free-org projects.
  const plans = new Map<string, Map<string, boolean | null>>();
  const free = new Map<string, number>();
  for (const row of rows) {
    try {
      const own = statuses.filter((s) => s.accountId === row.accountId);
      const org = own.find((s) => s.resourceId === row.id)?.orgSlug ?? "";
      if (!plans.has(row.accountId)) {
        const p = await accountPlans(row.accountId);
        plans.set(row.accountId, p);
        free.set(row.accountId, freeSlots(own.map((s) => ({ status: s.status, freeOrg: p.get(s.orgSlug ?? "") ?? null }))).left);
      }
      const paid = plans.get(row.accountId)!.get(org) === false;
      const slots = paid ? Number.POSITIVE_INFINITY : free.get(row.accountId)!;
      const a = access.get(row.accountId);
      // Denied after the owner's last tick and after the credential was last replaced or tested: stay stopped.
      const since = Math.max(row.k.updatedAt.getTime(), row.lastTestAt?.getTime() ?? 0);
      const denied = a?.write === "denied" && new Date(a.at).getTime() > since;
      const decision = autoRestoreDecision({ status: "INACTIVE", autoRestore: true, lastAutoRestoreAt: row.k.lastAutoRestoreAt, slotsLeft: slots, accessDenied: denied }, now);
      if (!decision.act) {
        if (decision.reason === "no-slot") {
          await recordEvents([{ at: now, type: "action", kind: "info", resourceId: row.id, actorUserId: null, reason: "AutoRestoreWaits", message: `Auto-restore: ${row.name} waits, account ${row.label} has no free slot`, detail: "Pause another project in this account, or restore it by hand once a slot is free." }]);
        }
        continue;
      }
      // A member paused it through the console after the owner last ticked the box: that pause was on purpose (often
      // to free the slot for another project), so Auto-restore leaves it until the owner ticks the box again.
      const pausedAt = await lastConsolePause(row.id);
      if (pausedAt && pausedAt.getTime() > row.k.updatedAt.getTime()) continue;
      const ms = timeLeft();
      if (ms < 250) return;
      // The attempt is stamped first, so a crash or timeout can't turn into a retry every 5 minutes.
      await db().update(keepActive).set({ lastAutoRestoreAt: now }).where(eq(keepActive.resourceId, row.id));
      const token = openOrNull({ ciphertext: row.ciphertext, iv: row.iv }, serverEnv().OPS_ENCRYPTION_KEY);
      if (!token) continue;
      const r = await restoreProject(token, row.ref, { timeoutMs: Math.min(CALL_MS, ms) });
      if (r.ok) {
        if (!paid) free.set(row.accountId, free.get(row.accountId)! - 1);
        await setWriteAccess(row.accountId, "ok");
        await recordEvents([{ at: now, type: "action", kind: "ok", resourceId: row.id, actorUserId: null, message: `Auto-restore: restoring ${row.name}`, detail: null }]);
      } else {
        if (r.kind === "scope") await setWriteAccess(row.accountId, "denied");
        await recordEvents([{
          at: now, type: "action", kind: "err", resourceId: row.id, actorUserId: null, message: `Auto-restore: ${row.name} couldn't be restored`,
          detail: r.kind === "scope" ? `${scopeMessage("supabase", {})} Auto-restore stops until then.` : shortDetail(r.error),
        }]);
      }
    } catch (e) {
      console.warn("auto-restore failed:", safe(e));
    }
  }
}

// Stage 9 (office proposal "supabase_keepalive", for an AutoPauseRisk alert): one keep-alive now, the same read-only
// query as the daily step, with the console's guards: the per-actor quota and per-project cooldown, the project must
// still be watched with a readable credential, and at most one keep-alive per 20 h (a second one is a no-op, so a retry
// or two approvals can't stack). Audited like a console action (actor: the approving owner; null for the auto-run).
export async function keepAliveNow(actor: Actor, resourceId: string, fin: Finisher = finish, now = new Date()): Promise<ActionResult> {
  const quota = await targetQuota(actor.id, "keep-alive", resourceId);
  if (quota) return { ok: false, error: quota };
  const t = await loadTarget(resourceId, "supabase_project");
  if (!t) return { ok: false, error: "This project isn't watched any more, or its credential can't be read." };
  const [k] = await db().select({ last: keepActive.lastKeepAliveAt }).from(keepActive).where(eq(keepActive.resourceId, resourceId)).limit(1);
  if (k?.last && now.getTime() - k.last.getTime() < KEEP_ALIVE_MIN_GAP_MS) return fin({ done: false, message: "A keep-alive was already sent in the last 20 hours." }, actor, t.account.id);
  const name = t.resource.name;
  const res = await keepAlive(t.token, t.resource.externalId, { timeoutMs: CALL_MS });
  if (res.ok) {
    await db().insert(keepActive).values({ resourceId, lastKeepAliveAt: now }).onConflictDoUpdate({ target: keepActive.resourceId, set: { lastKeepAliveAt: now } });
  }
  return fin(res.ok
    ? { done: true, message: `Keep-alive sent to ${name}.`, audit: { message: `Keep-alive sent · ${name}`, resourceId } }
    : { done: false, failed: { ok: false, kind: res.kind, error: res.kind === "scope" ? "This token can't run the read-only query (Database read)." : res.error, ...(res.status ? { status: res.status } : {}) }, audit: { message: `Keep-alive failed · ${name}`, resourceId } },
  actor, t.account.id);
}
