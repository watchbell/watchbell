// Watchbell 1.2.1 (audit L5/L6): exponential back-off after failed passwords and MFA codes, instead of a hard fixed
// window. The first `free` failures of a day cost nothing; after that each failure makes the next attempt wait twice
// as long as the one before (30 s, 1 min, 2 min … up to an hour), counted from the last failure. Applied per account
// and IP, and per IP, so failures from another network never lock the owner out (self-host needs
// WATCHBELL_TRUSTED_PROXY_HOPS to know the network; without it the account alone is the subject). Pure.

import { subjectKey } from "@/lib/rate-limit";

export const BACKOFF = { free: 5, baseS: 30, capS: 3600, windowS: 86_400 } as const;
// A Telegram alert after this many failures for one account in a day, at most once an hour (the caller's limit).
export const ALERT_AFTER = 10;

export function backoffDelayS(failures: number, o: { free: number; baseS: number; capS: number } = BACKOFF): number {
  if (failures < o.free) return 0;
  return Math.min(o.capS, o.baseS * 2 ** Math.min(30, failures - o.free));
}

// Seconds still to wait before the next attempt (0: go ahead).
export function backoffWaitS(failures: number, lastFailure: Date | null, now: Date, o: { free: number; baseS: number; capS: number } = BACKOFF): number {
  const delay = backoffDelayS(failures, o);
  if (!delay || !lastFailure) return 0;
  return Math.max(0, Math.ceil((lastFailure.getTime() + delay * 1000 - now.getTime()) / 1000));
}

// The subjects of the self-host password sign-in (lib/local-auth/signin.ts) and the MFA step (app/mfa/actions.ts).
export const BACKOFF_NAMES = {
  accountIp: "password-account-ip", ip: "password-ip-backoff", account: "password-account", mfa: "mfa-code-backoff",
  accountAll: "password-account-all", knownNet: "password-known-net",
} as const;

// Review I2: one account across every network (behind a trusted proxy, where each network has its own subjects). A
// generous free budget, then the same doubling; a network that signed in to that account before skips it, so a
// distributed guesser is bounded while the owner's own networks are never locked out.
export const ACCOUNT_BACKOFF = { free: 50, baseS: 30, capS: 3600 } as const;
// How long a network that signed in stays "known" for that account: well past a session's 30 days (review T2b-fix I-3),
// and the self-host proxy renews it while a session is used from there (at most once a day).
export const KNOWN_NETWORK_DAYS = 90;

// The rate_limits keys of one subject's back-off: the day's failure count and the "last failure" rows
// (lib/backoff-db.ts). Only hashes of the subject.
export function backoffKeys(name: string, subject: string): [count: string, last: string] {
  return [subjectKey({ name, max: 0, windowSeconds: BACKOFF.windowS }, subject), subjectKey({ name: `${name}-last`, max: 0, windowSeconds: 0 }, subject)];
}

export const failureAlertDue = (failuresToday: number): boolean => failuresToday >= ALERT_AFTER;
