import "server-only";
import { BACKOFF_NAMES, failureAlertDue } from "@/lib/backoff";
import { backoffClear, backoffFail, backoffWait } from "@/lib/backoff-db";
import { notifyAuthFailures } from "@/lib/data/auth-alert";

// Watchbell 1.2.1 (audit L6): wrong authenticator codes back off exponentially per user (on top of the 5-per-5-minutes
// window), and 10 in a day send the Telegram alert (at most once an hour). A right code starts the user over.
export const mfaWait = (userId: string): Promise<number> => backoffWait(BACKOFF_NAMES.mfa, userId);

export async function mfaFailed(userId: string): Promise<void> {
  const n = await backoffFail(BACKOFF_NAMES.mfa, userId);
  if (failureAlertDue(n)) await notifyAuthFailures("mfa", userId, n);
}

export const mfaPassed = (userId: string): Promise<void> => backoffClear(BACKOFF_NAMES.mfa, userId);
