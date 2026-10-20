import "server-only";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { toString as qrString } from "qrcode";
import { db } from "@/db/client";
import { localUsers } from "@/db/schema";
import { openOrNull, seal } from "@/lib/crypto";
import { newTotpSecret, totpUri, verifyTotp } from "./totp";

// Self-host TOTP: the secret lives sealed (AES-GCM, OPS_ENCRYPTION_KEY) in local_users.totp_secret_sealed as
// "v1:<iv>:<ciphertext>". Each accepted code's step is stored in the same statement that accepts it, so a code can't be
// used twice, not even by two requests at once.

const PREFIX = "v1";

export function sealTotpSecret(secret: string, keyB64: string): string {
  const s = seal(secret, keyB64);
  return `${PREFIX}:${s.iv}:${s.ciphertext}`;
}

export function openTotpSecret(stored: string | null, keyB64: string): string | null {
  const [prefix, iv, ciphertext, extra] = (stored ?? "").split(":");
  if (prefix !== PREFIX || !iv || !ciphertext || extra !== undefined) return null;
  return openOrNull({ iv, ciphertext }, keyB64);
}

export type LocalEnrollment = { ok: true; qr: string; secret: string } | { ok: false; error: string };

// A new (unconfirmed) secret replaces any earlier unconfirmed one. Refused once a factor is confirmed: a password alone
// (an aal1 session) must never be enough to swap the authenticator.
export async function startLocalEnrollment(userId: string, email: string, keyB64: string): Promise<LocalEnrollment> {
  const secret = newTotpSecret();
  const rows = await db()
    .update(localUsers)
    .set({ totpSecretSealed: sealTotpSecret(secret, keyB64), totpLastStep: null, updatedAt: new Date() })
    .where(and(eq(localUsers.id, userId), isNull(localUsers.totpConfirmedAt)))
    .returning({ id: localUsers.id });
  if (rows.length === 0) return { ok: false, error: "Your authenticator is already set up. Sign in with its code." };
  const svg = await qrString(totpUri(secret, email), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { ok: true, qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, secret };
}

type Purpose = "confirm" | "verify";

// Checks the code against the user's secret and, in one statement, records its step (and for "confirm" turns the
// factor on). False for a wrong, reused or out-of-window code, or when the factor is not in the state the purpose needs.
export async function acceptLocalCode(userId: string, code: string, purpose: Purpose, keyB64: string, now = Date.now()): Promise<boolean> {
  const [user] = await db()
    .select({ sealed: localUsers.totpSecretSealed, confirmedAt: localUsers.totpConfirmedAt, lastStep: localUsers.totpLastStep })
    .from(localUsers)
    .where(eq(localUsers.id, userId))
    .limit(1);
  if (!user?.sealed) return false;
  if ((purpose === "confirm") !== (user.confirmedAt === null)) return false;
  const secret = openTotpSecret(user.sealed, keyB64);
  if (!secret) return false;
  const result = verifyTotp(secret, code, now, user.lastStep);
  if (!result.ok) return false;
  const rows = await db()
    .update(localUsers)
    .set({
      totpLastStep: result.step,
      updatedAt: new Date(now),
      ...(purpose === "confirm" ? { totpConfirmedAt: new Date(now) } : {}),
    })
    .where(
      and(
        eq(localUsers.id, userId),
        // The secret checked above is still the one stored (no new enrollment in between).
        eq(localUsers.totpSecretSealed, user.sealed),
        purpose === "confirm" ? isNull(localUsers.totpConfirmedAt) : isNotNull(localUsers.totpConfirmedAt),
        or(isNull(localUsers.totpLastStep), lt(localUsers.totpLastStep, result.step)),
      ),
    )
    .returning({ id: localUsers.id });
  return rows.length > 0;
}
