import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { localUsers } from "@/db/schema";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { hitLimit, peekLimit, refundLimit } from "@/lib/rate-limit-db";
import { hashPassword, passwordProblem, TEMP_PASSWORD_EXPIRED, verifyPassword } from "./password";
import { readLocalSession, replaceLocalSession, revokeOtherLocalSessions } from "./sessions-db";

// Self-host: a member changes their own password (also the forced change after a temporary one). The current password
// is checked (wrong guesses are limited per user), the new one replaces it, must_change_password is cleared, every other
// session of the user ends and the current one gets a fresh token with the same aal. All in one transaction. An expired
// temporary password is refused here too (after the check, so only its holder learns that).

export type PasswordField = "current" | "password" | "confirm";
export type ChangePasswordResult =
  | { status: "ok"; token: string }
  | { status: "signed-out" }
  | { status: "error"; message: string; field?: PasswordField };

const MAX_CURRENT = 1024;
const WRONG_CURRENT = "That isn't your current password.";

class SessionGone extends Error {}

const tooMany = (retryAfter: number): ChangePasswordResult => ({
  status: "error",
  message: `Too many wrong passwords. Try again in ${minutesText(retryAfter)}.`,
  field: "current",
});

export async function changeLocalPassword(input: {
  token: string;
  current: string;
  password: string;
  confirm: string;
  userAgent: string | null;
}): Promise<ChangePasswordResult> {
  const session = await readLocalSession(input.token);
  if (!session) return { status: "signed-out" };
  const { userId } = session;

  if (!input.current) return { status: "error", message: "Enter your current password.", field: "current" };
  const problem = passwordProblem(input.password);
  if (problem) return { status: "error", message: problem, field: "password" };
  if (input.password !== input.confirm) return { status: "error", message: "The new passwords don't match.", field: "confirm" };
  if (input.password === input.current) return { status: "error", message: "Pick a password different from the current one.", field: "password" };

  const peeked = await peekLimit(LIMITS.passwordChange, userId);
  if (!peeked.allowed) return tooMany(peeked.retryAfter);
  // Counted before the (slow) check, so parallel guesses can't all pass a stale count; every outcome except a wrong
  // password gives the hit back, in the window it was counted in.
  const hit = await hitLimit(LIMITS.passwordChange, userId);
  const refund = () => refundLimit(LIMITS.passwordChange, userId, hit.windowStart);
  if (!hit.allowed) {
    await refund();
    return tooMany(hit.retryAfter);
  }

  const [user] = await db()
    .select({ passwordHash: localUsers.passwordHash, tempPasswordExpiresAt: localUsers.tempPasswordExpiresAt })
    .from(localUsers)
    .where(eq(localUsers.id, userId))
    .limit(1);
  if (!user) {
    await refund();
    return { status: "signed-out" };
  }
  if (input.current.length > MAX_CURRENT || !(await verifyPassword(input.current, user.passwordHash))) {
    return { status: "error", message: WRONG_CURRENT, field: "current" };
  }
  await refund();
  if (user.tempPasswordExpiresAt && user.tempPasswordExpiresAt.getTime() <= Date.now()) {
    return { status: "error", message: TEMP_PASSWORD_EXPIRED, field: "current" };
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const token = await db().transaction(async (tx) => {
      const replaced = await replaceLocalSession(input.token, { aal: session.aal, userAgent: input.userAgent }, new Date(), tx);
      // Ended meanwhile (signed out elsewhere): nothing changes.
      if (!replaced || replaced.userId !== userId) throw new SessionGone();
      await tx.update(localUsers).set({ passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null, updatedAt: new Date() }).where(eq(localUsers.id, userId));
      await revokeOtherLocalSessions(userId, replaced.token, tx);
      return replaced.token;
    });
    return { status: "ok", token };
  } catch (e) {
    if (e instanceof SessionGone) return { status: "signed-out" };
    throw e;
  }
}
