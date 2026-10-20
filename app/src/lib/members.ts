import { z } from "zod";
import { ROLES, type Role } from "@/lib/roles";

export const INVITE_DAYS = 7;
// pg_advisory_xact_lock key for every owner change (Settings' role changes and removals, self-host first-run setup):
// "at least one owner" / "no owner yet" checks and their writes run in one transaction that takes it first.
export const OWNERS_LOCK = 7_412_001;
const LAST_OWNER = "The console needs at least one owner. Make someone else an owner first.";

export function validateInvite(
  input: { email: string; role: string },
  existing: { memberEmails: string[]; openInviteEmails: string[] },
): { ok: true; email: string; role: Role } | { ok: false; fieldErrors: Record<string, string> } {
  const email = input.email.trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, fieldErrors: { email: "Enter a valid email address." } };
  if (!(ROLES as readonly string[]).includes(input.role)) return { ok: false, fieldErrors: { role: "Pick a role." } };
  if (existing.memberEmails.includes(email)) return { ok: false, fieldErrors: { email: "That person is already a member." } };
  if (existing.openInviteEmails.includes(email)) return { ok: false, fieldErrors: { email: "That person is already invited." } };
  return { ok: true, email, role: input.role as Role };
}

export function roleChangeProblem(target: { id: string; role: Role }, newRole: Role, ownerCount: number): string | null {
  if (target.role === "owner" && newRole !== "owner" && ownerCount <= 1) return LAST_OWNER;
  return null;
}

export function removalProblem(target: { id: string; role: Role }, actor: { id: string }, ownerCount: number): string | null {
  if (target.id === actor.id) return "You can't remove yourself. Ask another owner.";
  if (target.role === "owner" && ownerCount <= 1) return LAST_OWNER;
  return null;
}

export function inviteStatus(invite: { expiresAt: Date; acceptedAt: Date | null }, now: Date): "open" | "expired" | "used" {
  if (invite.acceptedAt) return "used";
  return invite.expiresAt > now ? "open" : "expired";
}

// What to do when Supabase refuses to create the invitee's login: "exists" is fine (the login is already
// there), anything else is worth a retry. createUser sends no email, so there is no SMTP case here.
export function inviteErrorOutcome(error: { code?: string; message: string }): "exists" | "retry" {
  if (error.code === "email_exists") return "exists";
  return "retry";
}

// The result shown to the owner once the invite row is saved. No email is sent: the invitee signs in at
// /signin themselves, behind the bot check. Supabase's built-in mailer only delivers to the project's
// team members, so the sign-in link reaches anyone else only once custom SMTP is configured.
export function inviteSavedMessage(email: string, siteUrl: string): string {
  return (
    `Invite saved. Ask ${email} to sign in at ${siteUrl.replace(/\/+$/, "")}/signin within ${INVITE_DAYS} days. ` +
    "Sign-in emails reach only Supabase team members until custom SMTP is set up."
  );
}

const ROLE_NAME: Record<Role, string> = { owner: "an Owner", operator: "an Operator", viewer: "a Viewer" };
const ROLE_NOUN: Record<Role, string> = { owner: "Owner", operator: "Operator", viewer: "Viewer" };

// Wording for the confirmation before a role changes. Promoting to Owner and demoting from Owner are the
// two changes that move control of the console, so they get the red button.
export function roleChangeCopy(email: string, from: Role, to: Role): { title: string; body: string; cta: string; danger: boolean } {
  const body: Record<Role, string> = {
    owner: "Owners can manage connections, users, and settings, including removing other owners.",
    operator: "They can redeploy, restore, wake, and silence alerts. They can't change connections, users, or settings.",
    viewer: "They become read-only, with no logs and no actions.",
  };
  return {
    title: to === "owner" ? `Make ${email} ${ROLE_NAME.owner}?` : `Change ${email} to ${ROLE_NOUN[to]}?`,
    body: from === "owner" ? `They lose access to connections, users, and settings. ${body[to]}` : body[to],
    cta: to === "owner" ? "Make Owner" : `Change to ${ROLE_NOUN[to]}`,
    danger: to === "owner" || from === "owner",
  };
}
