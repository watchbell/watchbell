import "server-only";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { and, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { readEnv } from "@/lib/brand-env";
import { type Db, db } from "@/db/client";
import { localUsers, members, rateLimits, settings } from "@/db/schema";
import { OWNERS_LOCK } from "@/lib/members";
import { type Limit, type LimitDecision, LIMITS, minutesText } from "@/lib/rate-limit";
import { hashPassword, passwordProblem } from "./password";
import { hashSetupCode, newSetupCode } from "./setup-code";

// Self-host first run. While nobody owns the console, every server start prints a fresh one-time code to the log (the
// only place it ever appears) and stores its HMAC in ops.settings. Whoever can read the log can open /setup, type the
// code and become the first owner. Once an owner exists the code is gone and /setup is a 404.

export const SETUP_CODE_SETTING = "selfhost.setupCode";
export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

// The printed code is also written to <WATCHBELL_DATA_DIR>/setup-code (owner-only where the OS supports modes), for
// installs where reading the server log is awkward (a container). Removed once an owner exists.
export function setupCodeFile(source: Record<string, string | undefined> = process.env): string {
  return resolve(/*turbopackIgnore: true*/ readEnv(source, "DATA_DIR") || "./data", "setup-code");
}

// Best effort: the log line stays the source of truth, so a read-only folder only costs a warning.
function writeCodeFile(file: string, code: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Removed first: a mode only applies when the file is created.
    rmSync(file, { force: true });
    writeFileSync(file, `${code}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    console.warn(`Watchbell couldn't write the setup code to ${file}; use the code in this log.`);
  }
}

function removeCodeFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    console.warn(`Watchbell couldn't remove ${file}; delete it by hand.`);
  }
}

// Creating the first owner is an owner change: it takes OWNERS_LOCK, so two setup submits at the same moment can't both
// pass the "no owner yet" check.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;
type StoredCode = { hash: string; expiresAt: string };

export async function ownerExists(conn: Conn = db()): Promise<boolean> {
  const [row] = await conn.select({ id: members.id }).from(members).where(eq(members.role, "owner")).limit(1);
  return row !== undefined;
}

async function readStoredCode(conn: Conn): Promise<StoredCode | null> {
  const [row] = await conn.select({ value: settings.value }).from(settings).where(eq(settings.key, SETUP_CODE_SETTING)).limit(1);
  const v = row?.value as Partial<StoredCode> | undefined;
  return typeof v?.hash === "string" && typeof v.expiresAt === "string" ? { hash: v.hash, expiresAt: v.expiresAt } : null;
}

// Failed code attempts, per IP (only when a trusted proxy names it, see client-ip.ts) and in total. Only failures count,
// and a restart clears them along with the old code, so nobody on the network can keep /setup locked past a restart.
const SETUP_LIMITS = [LIMITS.setupIp, LIMITS.setupAll];
const ALL = "all";

async function clearSetupAttempts(): Promise<void> {
  await db()
    .delete(rateLimits)
    .where(or(...SETUP_LIMITS.map((l) => like(rateLimits.key, `${l.name}:%`))));
}

/** XXXXX-XXXXX: easier to read off a log line. hashSetupCode ignores the dash. */
export const formatSetupCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

/**
 * At server start. No owner: create (or replace) the code, store its hash with a 24 h expiry and print it once.
 * An owner exists: drop any leftover code and print nothing. Returns whether a code was printed.
 */
export async function ensureSetupCode(opts: {
  key: Uint8Array;
  siteUrl: string;
  now?: Date;
  log?: (line: string) => void;
  codeFile?: string;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const codeFile = opts.codeFile ?? setupCodeFile();
  if (await ownerExists()) {
    await db().delete(settings).where(eq(settings.key, SETUP_CODE_SETTING));
    removeCodeFile(codeFile);
    return false;
  }
  const { code, hash } = newSetupCode(opts.key);
  await clearSetupAttempts();
  const value: StoredCode = { hash, expiresAt: new Date(now.getTime() + SETUP_CODE_TTL_MS).toISOString() };
  await db()
    .insert(settings)
    .values({ key: SETUP_CODE_SETTING, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  const url = `${opts.siteUrl.replace(/\/+$/, "")}/setup`;
  (opts.log ?? console.log)(`Watchbell setup code: ${formatSetupCode(code)} (open ${url}; valid 24 h)`);
  writeCodeFile(codeFile, formatSetupCode(code));
  return true;
}

export type SetupInput = { code: string; email: string; password: string; confirm: string };
export type SetupField = "code" | "email" | "password" | "confirm";
export type SetupResult =
  | { status: "ok"; userId: string }
  // An owner exists (set up meanwhile, maybe by a parallel submit): the page is gone.
  | { status: "done" }
  | { status: "error"; message: string; field?: SetupField };

type LimitFn = (l: Limit, subject: string) => Promise<LimitDecision>;

const WRONG_CODE: SetupResult = { status: "error", message: "That setup code is wrong. Copy it from where you started Watchbell, or from its log.", field: "code" };
const EXPIRED_CODE: SetupResult = {
  status: "error",
  message: "That setup code has expired. Restart Watchbell to print a new one.",
  field: "code",
};

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function checkCode(stored: StoredCode | null, typedHash: string, now: Date): SetupResult | null {
  if (!stored || !sameHash(stored.hash, typedHash)) return WRONG_CODE;
  if (!(Date.parse(stored.expiresAt) > now.getTime())) return EXPIRED_CODE;
  return null;
}

function validate(input: SetupInput): SetupResult | null {
  if (!input.code.trim()) return { status: "error", message: "Enter the setup code that watchbell start printed (it is in the log too).", field: "code" };
  if (input.email.length > 320 || !z.email().safeParse(input.email).success) return { status: "error", message: "Enter a valid email address.", field: "email" };
  const problem = passwordProblem(input.password);
  if (problem) return { status: "error", message: problem, field: "password" };
  if (input.password !== input.confirm) return { status: "error", message: "The passwords don't match.", field: "confirm" };
  return null;
}

/**
 * Creates the first owner: a local user, its owner membership, and consumes the code, all in one transaction under the
 * owners lock, then removes the setup-code file. Wrong or expired codes are limited (SETUP_LIMITS); `ip` is null when it
 * can't be trusted. The caller signs the new owner in (aal1) and sends them to /mfa/setup.
 */
export async function completeSetup(
  raw: SetupInput,
  deps: { ip: string | null; key: Uint8Array; limit: LimitFn; peek: LimitFn; now?: Date; codeFile?: string },
): Promise<SetupResult> {
  const result = await createFirstOwner(raw, deps);
  // An owner exists now (this submit or an earlier one): the code file has no use any more.
  if (result.status !== "error") removeCodeFile(deps.codeFile ?? setupCodeFile());
  return result;
}

async function createFirstOwner(
  raw: SetupInput,
  deps: { ip: string | null; key: Uint8Array; limit: LimitFn; peek: LimitFn; now?: Date },
): Promise<SetupResult> {
  const now = deps.now ?? new Date();
  const input = { ...raw, email: raw.email.trim().toLowerCase() };
  const invalid = validate(input);
  if (invalid) return invalid;

  if (await ownerExists()) return { status: "done" };
  const subjects: [Limit, string][] = [[LIMITS.setupAll, ALL], ...(deps.ip ? [[LIMITS.setupIp, deps.ip] as [Limit, string]] : [])];
  for (const [l, subject] of subjects) {
    const d = await deps.peek(l, subject);
    if (!d.allowed) return { status: "error", message: `Too many wrong codes. Try again in ${minutesText(d.retryAfter)}, or restart Watchbell.` };
  }

  // A cheap check before the expensive password hash, so a wrong code costs no scrypt run. Repeated inside the lock.
  const typedHash = hashSetupCode(input.code, deps.key);
  const early = checkCode(await readStoredCode(db()), typedHash, now);
  if (early) {
    for (const [l, subject] of subjects) await deps.limit(l, subject);
    return early;
  }

  const passwordHash = await hashPassword(input.password);
  return db().transaction(async (tx): Promise<SetupResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${OWNERS_LOCK})`);
    if (await ownerExists(tx)) return { status: "done" };
    const bad = checkCode(await readStoredCode(tx), typedHash, now);
    if (bad) return bad;
    const [user] = await tx.insert(localUsers).values({ email: input.email, passwordHash }).returning({ id: localUsers.id });
    await tx.insert(members).values({ userId: user.id, email: input.email, role: "owner", lastSeenAt: now });
    // Consumed: only the row that was checked above, so a code rotated meanwhile is not removed by mistake.
    await tx.delete(settings).where(and(eq(settings.key, SETUP_CODE_SETTING), sql`${settings.value}->>'hash' = ${typedHash}`));
    return { status: "ok", userId: user.id };
  });
}
