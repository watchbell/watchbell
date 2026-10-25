import { and, eq, like, notLike, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { localSessions, localUsers, rateLimits } from "@/db/schema";
import { BACKOFF_NAMES } from "@/lib/backoff";
import { LIMITS, subjectKey } from "@/lib/rate-limit";
import { hashPassword, newTemporaryPassword, temporaryPasswordExpiry } from "./password";

// Self-host account recovery (`npm run reset-login -- <email>`, scripts/reset-login.mts), for someone locked out of
// their password or authenticator, the last owner included. The account gets a new temporary password (valid 7 days,
// to be changed at the next sign-in), loses its authenticator (set up again at the next sign-in when the role needs
// one) and every session it has. No "server-only": the CLI runs this outside Next, on a database handle it opened.

export type ResetLoginResult = { ok: true; email: string; password: string; expiresAt: Date } | { ok: false; reason: "unknown-email" };

export async function resetLogin(conn: Db, rawEmail: string, now: Date = new Date()): Promise<ResetLoginResult> {
  const email = rawEmail.trim().toLowerCase();
  const password = newTemporaryPassword();
  const passwordHash = await hashPassword(password);
  const expiresAt = temporaryPasswordExpiry(now);
  return conn.transaction(async (tx): Promise<ResetLoginResult> => {
    const [user] = await tx
      .update(localUsers)
      .set({
        passwordHash,
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        totpSecretSealed: null,
        totpConfirmedAt: null,
        totpLastStep: null,
        updatedAt: now,
      })
      .where(eq(localUsers.email, email))
      .returning({ id: localUsers.id });
    if (!user) return { ok: false, reason: "unknown-email" };
    await tx.delete(localSessions).where(eq(localSessions.userId, user.id));
    // A lockout someone else caused (failed sign-ins on this email) must not keep the person out of their recovery.
    // Behind a trusted proxy the back-off rows are keyed by email and network together (hashed), so they can't be
    // picked out for one email (review m2): every password sign-in limit is cleared, for every account (the CLI says
    // so). The known networks (password-known-net) and other users' password-change limits stay.
    await tx.delete(rateLimits).where(or(
      eq(rateLimits.key, subjectKey(LIMITS.passwordChange, user.id)),
      and(like(rateLimits.key, "password-%"), notLike(rateLimits.key, `${BACKOFF_NAMES.knownNet}:%`), notLike(rateLimits.key, `${LIMITS.passwordChange.name}:%`)),
    ));
    return { ok: true, email, password, expiresAt };
  });
}
