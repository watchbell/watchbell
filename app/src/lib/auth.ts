import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db/client";
import { invites, members } from "@/db/schema";
import { AuthError } from "@/lib/action";
import { authProvider, type SessionUser } from "@/lib/auth-provider";
import { mfaStep, type MfaStep } from "@/lib/mfa";
import { hasRole, type Role } from "@/lib/roles";

export type Member = { id: string; userId: string; email: string; role: Role };

// Both lookups are wrapped in React's cache(): within one server render the console layout and the page share a
// single result instead of asking Supabase and the database twice (final review I4). Outside a render (Server
// Actions, Route Handlers) cache() doesn't memoize, so an action always sees the current member and role.
export const getSessionUser = cache(async (): Promise<SessionUser | null> => authProvider().sessionUser());

// Where a page sends a session the auth provider no longer knows (Supabase in cloud, local_sessions in self-host).
// Server Components can't clear cookies; this Route Handler can, so the browser doesn't keep bouncing between /signin
// and a failing page.
const SESSION_ENDED = "/auth/session-ended";
// Self-host: where an account that still has its temporary password goes, after the MFA step.
const PASSWORD_CHANGE = "/account/password";

// "signed-out": the session no longer exists server-side (signed out on another device).
async function stepFor(member: Member, aal: string | undefined): Promise<MfaStep | "signed-out"> {
  if (aal === "aal2") return "ok";
  const hasVerifiedFactor = await authProvider().hasVerifiedFactor(member.userId);
  if (hasVerifiedFactor === "signed-out") return "signed-out";
  return mfaStep({ role: member.role, aal, hasVerifiedFactor });
}

// For the /mfa pages themselves: signed in and a member, whatever the MFA state.
export async function currentMfa(): Promise<{ member: Member; step: MfaStep }> {
  const session = await getSessionUser();
  if (!session) redirect("/signin");
  const member = await findMember(session.userId);
  if (!member) redirect("/auth/not-member");
  const step = await stepFor(member, session.aal);
  if (step === "signed-out") redirect(SESSION_ENDED);
  return { member, step };
}

export const findMember = cache(async (userId: string): Promise<Member | null> => {
  const [row] = await db()
    .select({ id: members.id, userId: members.userId, email: members.email, role: members.role })
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  return row ?? null;
});

export async function findOpenInvite(email: string) {
  const [row] = await db()
    .select()
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function touchLastSeen(userId: string) {
  await db().update(members).set({ lastSeenAt: new Date() }).where(eq(members.userId, userId));
}

export async function requirePageMember(): Promise<Member> {
  const session = await getSessionUser();
  if (!session) redirect("/signin");
  const member = await findMember(session.userId);
  if (member) {
    const step = await stepFor(member, session.aal);
    if (step === "signed-out") redirect(SESSION_ENDED);
    if (step === "setup") redirect("/mfa/setup");
    if (step === "challenge") redirect("/mfa");
    if (session.mustChangePassword) redirect(PASSWORD_CHANGE);
    return member;
  }
  if (session.email && (await findOpenInvite(session.email))) redirect("/invite");
  redirect("/auth/not-member");
}

export async function pageGate(min: Role): Promise<{ ok: boolean; member: Member }> {
  const member = await requirePageMember();
  return { ok: hasRole(member.role, min), member };
}

export async function requireActionMember(min: Role): Promise<Member> {
  const session = await getSessionUser();
  if (!session) throw new AuthError("signed-out");
  const member = await findMember(session.userId);
  if (!member) throw new AuthError("not-member");
  if (!hasRole(member.role, min)) throw new AuthError("forbidden");
  const step = await stepFor(member, session.aal);
  if (step === "signed-out") throw new AuthError("signed-out");
  if (step !== "ok") throw new AuthError("mfa");
  // Self-host: a temporary password is good for changing it at /account/password and nothing else.
  if (session.mustChangePassword) throw new AuthError("password-change");
  return member;
}
