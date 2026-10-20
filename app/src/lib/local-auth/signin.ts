import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { localUsers, members } from "@/db/schema";
import { mfaStep } from "@/lib/mfa";
import { safeNext } from "@/lib/paths";
import { type Limit, LIMITS } from "@/lib/rate-limit";
import { hitLimit, limit, peekLimit, refundLimit } from "@/lib/rate-limit-db";
import { dummyVerify, TEMP_PASSWORD_EXPIRED, verifyPassword } from "./password";
import { createLocalSession, revokeLocalSession } from "./sessions-db";

// `email` refills the field after a refused attempt (React resets the form when the action finishes). `field`: the demo
// form shows a message about the email under the Email field (self-host never sets it).
export type PasswordSignInState = { status: "idle" } | { status: "error"; message: string; email: string; field?: "email" | "password" };
export type PasswordSignInResult = { ok: true; token: string; redirectTo: string } | { ok: false; message: string };

// One answer for a wrong password and an unknown email, so the form doesn't tell who has an account.
export const WRONG = "Email or password is wrong.";
const MAX_EMAIL = 254;
const MAX_PASSWORD = 1024;

const lockedOut = (retryAfter: number): PasswordSignInResult => ({
  ok: false,
  message: `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfter / 60))} min.`,
});

// Where the browser goes after the password: the MFA step first when the role or an existing factor asks for one,
// then the forced password change, then where the person was heading.
async function nextStop(user: { id: string; totpConfirmedAt: Date | null; mustChangePassword: boolean }, next: string | null | undefined) {
  const [member] = await db().select({ role: members.role }).from(members).where(eq(members.userId, user.id)).limit(1);
  // Not a member: the console's own gate shows the "not on this console" page.
  if (!member) return "/";
  const step = mfaStep({ role: member.role, aal: "aal1", hasVerifiedFactor: user.totpConfirmedAt !== null });
  if (step === "challenge") return "/mfa";
  if (step === "setup") return "/mfa/setup";
  return user.mustChangePassword ? "/account/password" : safeNext(next);
}

type Counted = { l: Limit; subject: string; windowStart: Date };

// Called after a wrong password (or unknown email): the shared per-IP count, and a warning (once per window) when
// failures across every email pile up, which on an install without a trusted proxy is the only sign of a spray.
async function recordFailure(ip: string | null): Promise<void> {
  if (ip) await limit(LIMITS.passwordIp, ip);
  const all = await hitLimit(LIMITS.passwordFailuresAll, "all");
  if (all.count === LIMITS.passwordFailuresAll.max + 1) {
    console.warn("many failed sign-ins; consider a trusted proxy / firewall in front of Watchbell");
  }
}

export async function passwordSignIn(input: {
  email: string;
  password: string;
  // Null when the client's address isn't trustworthy (no trusted proxy): no per-IP limits then.
  ip: string | null;
  userAgent: string | null;
  // The session the browser already presents, if any: it ends before the new one starts.
  presentedToken: string | undefined;
  next?: string | null;
}): Promise<PasswordSignInResult> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (!email || !password || email.length > MAX_EMAIL || password.length > MAX_PASSWORD) return { ok: false, message: WRONG };

  // Every applicable limit is looked at first, so a refused attempt adds to none of them.
  const subjects: [Limit, string][] = [[LIMITS.passwordEmail, email]];
  if (input.ip) subjects.unshift([LIMITS.passwordEmailIp, `${email} ${input.ip}`]);
  const peeked: [Limit, string][] = input.ip ? [[LIMITS.passwordIp, input.ip], ...subjects] : subjects;
  for (const [l, subject] of peeked) {
    const d = await peekLimit(l, subject);
    if (!d.allowed) return lockedOut(d.retryAfter);
  }
  // The email counters are bumped before the (slow) password check, so parallel guesses can't all pass a stale count;
  // a success gives them back. A guess that loses that race is refused and gives back what it took.
  const counted: Counted[] = [];
  for (const [l, subject] of subjects) {
    const d = await hitLimit(l, subject);
    counted.push({ l, subject, windowStart: d.windowStart });
    if (!d.allowed) {
      for (const c of counted) await refundLimit(c.l, c.subject, c.windowStart);
      return lockedOut(d.retryAfter);
    }
  }

  const [user] = await db()
    .select({
      id: localUsers.id,
      passwordHash: localUsers.passwordHash,
      totpConfirmedAt: localUsers.totpConfirmedAt,
      mustChangePassword: localUsers.mustChangePassword,
      tempPasswordExpiresAt: localUsers.tempPasswordExpiresAt,
    })
    .from(localUsers)
    .where(eq(localUsers.email, email))
    .limit(1);
  if (!user) {
    // Same work as a real check, so an unknown email doesn't answer faster.
    await dummyVerify();
    await recordFailure(input.ip);
    return { ok: false, message: WRONG };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordFailure(input.ip);
    return { ok: false, message: WRONG };
  }

  for (const c of counted) await refundLimit(c.l, c.subject, c.windowStart);
  // An expired temporary password: said only after the right password, so it tells a guesser nothing.
  if (user.tempPasswordExpiresAt && user.tempPasswordExpiresAt.getTime() <= Date.now()) return { ok: false, message: TEMP_PASSWORD_EXPIRED };
  if (input.presentedToken) await revokeLocalSession(input.presentedToken);
  const { token } = await createLocalSession(user.id, { aal: "aal1", userAgent: input.userAgent });
  return { ok: true, token, redirectTo: await nextStop(user, input.next) };
}
