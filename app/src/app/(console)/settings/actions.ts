"use server";

import { and, count, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { invites, localUsers, members } from "@/db/schema";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { readBudgetLimits, readRetentionDays, saveBudgetLimits, saveRetentionDays } from "@/lib/data/settings-db";
import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { serverEnv } from "@/lib/env";
import { hashPassword, newTemporaryPassword, temporaryPasswordExpiry } from "@/lib/local-auth/password";
import { INVITE_DAYS, inviteErrorOutcome, inviteSavedMessage, OWNERS_LOCK, removalProblem, roleChangeProblem, validateInvite } from "@/lib/members";
import { isDemo, mode } from "@/lib/mode";
import { ROLES, type Role } from "@/lib/roles";
import { BUDGET_DEFAULTS, budgetChanges, validateBudget } from "@/lib/settings/budget";
import { retentionChanges, validateRetention } from "@/lib/settings/retention";
import { adminClient } from "@/lib/supabase/admin";
import { dailyRunText } from "@/lib/time";

const deps = { requireActionMember };

// B6: every Settings change is an audit entry (Events, type action, with the acting user). A failed audit write is
// logged and doesn't undo the change.
async function audit(actorUserId: string, message: string, detail?: string): Promise<void> {
  await recordAction({ kind: "ok", message, resourceId: null, actorUserId, ...(detail ? { detail: detail.slice(0, 500) } : {}) })
    .catch(() => console.warn("settings audit failed"));
}

// Owner changes check "at least one owner left" and then write. Two owners demoting or removing each
// other at the same moment could both pass the check, so those changes run in one transaction that
// first takes OWNERS_LOCK. Whoever gets it second sees the first one's result.

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function lockOwners(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${OWNERS_LOCK})`);
}

async function ownerCount(tx: Tx) {
  const [{ n }] = await tx.select({ n: count() }).from(members).where(eq(members.role, "owner"));
  return n;
}

export async function inviteUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    // The demo never adds people, and neither it nor self-host has Supabase to create the login.
    if (isDemo()) return { ok: false, error: DEMO_UNAVAILABLE };
    // Self-host has no Supabase to create the login: members are added with addMember.
    if (mode() === "selfhost") return { ok: false, error: "Use Add member on this console." };
    const memberEmails = (await db().select({ e: members.email }).from(members)).map((r) => r.e);
    const openInviteEmails = (await db().select({ e: invites.email }).from(invites).where(isNull(invites.acceptedAt))).map((r) => r.e);
    const v = validateInvite({ email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "") }, { memberEmails, openInviteEmails });
    if (!v.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: v.fieldErrors };

    // The invitee signs in at /signin themselves (behind the bot check); the confirmed login lets that work.
    const { error: createError } = await adminClient().auth.admin.createUser({ email: v.email, email_confirm: true });
    if (createError && inviteErrorOutcome(createError) !== "exists") {
      return { ok: false, error: "Supabase couldn't create the login for this invite. Try again." };
    }
    await db().insert(invites).values({
      email: v.email,
      role: v.role,
      invitedBy: actor.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    });
    await audit(actor.userId, `Invited ${v.email} as ${v.role}`);
    revalidatePath("/settings");
    // The invite row is what lets them in: signing in at /signin sends a non-member with an open invite to /invite.
    return { ok: true, message: inviteSavedMessage(v.email, serverEnv().SITE_URL) };
  }, deps);
}

// postgres.js puts the SQLSTATE on the error; newer drizzle wraps it as `cause`.
function isUniqueViolation(e: unknown): boolean {
  const o = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return (o?.code ?? o?.cause?.code) === "23505";
}

export type AddedMember = { email: string; password: string };

// Self-host: there is no mail service and no Supabase, so an owner creates the account directly. The temporary password
// is returned once, for the owner to pass on; only its scrypt hash is stored, and the member must replace it at first
// sign-in (must_change_password, enforced by the gates in src/lib/auth.ts) and within 7 days (temp_password_expires_at).
export async function addMember(_prev: ActionResult<AddedMember> | null, formData: FormData): Promise<ActionResult<AddedMember>> {
  return runGuarded("owner", async (actor): Promise<ActionResult<AddedMember>> => {
    if (isDemo()) return { ok: false, error: DEMO_UNAVAILABLE };
    if (mode() !== "selfhost") return { ok: false, error: "Use Invite user on this console." };
    const memberEmails = (await db().select({ e: members.email }).from(members)).map((r) => r.e);
    const accountEmails = (await db().select({ e: localUsers.email }).from(localUsers)).map((r) => r.e);
    const v = validateInvite(
      { email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "") },
      { memberEmails: [...memberEmails, ...accountEmails], openInviteEmails: [] },
    );
    if (!v.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: v.fieldErrors };

    const password = newTemporaryPassword();
    const passwordHash = await hashPassword(password);
    try {
      await db().transaction(async (tx) => {
        const [user] = await tx
          .insert(localUsers)
          .values({ email: v.email, passwordHash, mustChangePassword: true, tempPasswordExpiresAt: temporaryPasswordExpiry() })
          .returning({ id: localUsers.id });
        await tx.insert(members).values({ userId: user.id, email: v.email, role: v.role, invitedBy: actor.id });
      });
    } catch (e) {
      // Added by someone else in the meantime.
      if (isUniqueViolation(e)) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { email: "That person is already a member." } };
      throw e;
    }
    await audit(actor.userId, `Added ${v.email} as ${v.role}`);
    revalidatePath("/settings");
    return { ok: true, message: `${v.email} was added.`, data: { email: v.email, password } };
  }, deps);
}

export async function changeRole(memberId: string, role: Role): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    if (!ROLES.includes(role)) return { ok: false, error: "Pick a role." };
    const result = await db().transaction(async (tx): Promise<ActionResult<{ email: string; from: Role }>> => {
      await lockOwners(tx);
      const [target] = await tx.select().from(members).where(eq(members.id, memberId)).limit(1);
      if (!target) return { ok: false, error: "That member no longer exists." };
      const problem = roleChangeProblem(target, role, await ownerCount(tx));
      if (problem) return { ok: false, error: problem };
      await tx.update(members).set({ role, updatedAt: new Date() }).where(eq(members.id, memberId));
      return { ok: true, data: { email: target.email, from: target.role } };
    });
    if (!result.ok) return { ok: false, error: result.error };
    await audit(actor.userId, `Role changed: ${result.data?.email} ${result.data?.from} → ${role}`);
    revalidatePath("/settings");
    return { ok: true, message: `${result.data?.email} is now ${role === "owner" ? "an Owner" : role === "operator" ? "an Operator" : "a Viewer"}.` };
  }, deps);
}

export async function removeMember(memberId: string): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    // Self-host deletes the account with the membership. (The demo never gets here: it refuses removeMember, and its
    // visitor is the only member anyway.)
    const selfhost = mode() === "selfhost";
    const result = await db().transaction(async (tx): Promise<ActionResult<{ email: string }>> => {
      await lockOwners(tx);
      const [target] = await tx.select().from(members).where(eq(members.id, memberId)).limit(1);
      if (!target) return { ok: false, error: "That member no longer exists." };
      const problem = removalProblem(target, actor, await ownerCount(tx));
      if (problem) return { ok: false, error: problem };
      await tx.delete(members).where(eq(members.id, memberId));
      // Self-host: the account goes too, and its sessions with it (ON DELETE CASCADE), so they are out at once.
      if (selfhost) await tx.delete(localUsers).where(eq(localUsers.id, target.userId));
      return { ok: true, data: { email: target.email } };
    });
    if (!result.ok || !result.data) return { ok: false, error: result.ok ? "Something went wrong. Try again." : result.error };
    const { email } = result.data;
    if (selfhost) {
      await audit(actor.userId, `Removed ${email} from the console and deleted their account`);
      revalidatePath("/settings");
      return { ok: true, message: `${email} can't use the console anymore. Their account and sessions are deleted.` };
    }
    // Stage 7 (owner's rule): removal happens in the console only. The Supabase Auth login stays, but without a member
    // row or an open invite it gets no further than "not a member"; the owner can delete it in Supabase if wanted.
    await audit(actor.userId, `Removed ${email} from the console`);
    revalidatePath("/settings");
    return { ok: true, message: `${email} can't use the console anymore. Their Supabase login is left alone; delete it in Supabase → Authentication if you want.` };
  }, deps);
}

export async function revokeInvite(inviteId: string): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const deleted = await db().delete(invites).where(and(eq(invites.id, inviteId), isNull(invites.acceptedAt))).returning({ email: invites.email });
    revalidatePath("/settings");
    if (!deleted.length) return { ok: false, error: "That invite is already used or gone." };
    // In the console only (owner's rule): the login made for the invite stays, and can't get in without the invite.
    await audit(actor.userId, `Invite withdrawn: ${deleted[0].email}`);
    return { ok: true, message: `Invite for ${deleted[0].email} withdrawn.` };
  }, deps);
}

// ---- Stage 7 (B6): retention and free-tier limits, Owner only, audited ----

export async function saveRetention(input: Record<string, string>): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const v = validateRetention(input);
    if (!v.ok) return { ok: false, error: v.error, fieldErrors: v.fieldErrors };
    const before = await readRetentionDays();
    const changes = retentionChanges(before, v.value);
    if (!changes) return { ok: true, message: "Nothing changed." };
    await saveRetentionDays(v.value);
    await audit(actor.userId, "Settings: retention changed", changes);
    revalidatePath("/settings");
    return { ok: true, message: `Retention saved. The daily job uses it from its next run (${dailyRunText()}).` };
  }, deps, "local");
}

export async function saveBudget(input: Record<string, string>): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const v = validateBudget(input);
    if (!v.ok) return { ok: false, error: v.error, fieldErrors: v.fieldErrors };
    const before = await readBudgetLimits();
    const changes = budgetChanges(before, v.value);
    if (!changes) return { ok: true, message: "Nothing changed." };
    await saveBudgetLimits(v.value);
    await audit(actor.userId, "Settings: free tier limits changed", changes);
    revalidatePath("/settings");
    return { ok: true, message: "Free tier limits saved." };
  }, deps, "local");
}

export async function resetBudget(): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const before = await readBudgetLimits();
    const changes = budgetChanges(before, BUDGET_DEFAULTS);
    if (!changes) return { ok: true, message: "The limits are already the published defaults." };
    await saveBudgetLimits(BUDGET_DEFAULTS);
    await audit(actor.userId, "Settings: free tier limits reset", changes);
    revalidatePath("/settings");
    return { ok: true, message: "Free tier limits reset to the published defaults." };
  }, deps, "local");
}
