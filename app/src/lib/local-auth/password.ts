import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAX_VERIFY_LENGTH = 1024;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns a message when the password breaks the rules, otherwise null. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  return null;
}

/** Stored format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  // Pin the parameters: a stored row must not choose its own cost.
  if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return false;
  if (Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P) return false;
  if (password.length > MAX_VERIFY_LENGTH) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  let key: Buffer;
  try {
    key = await derive(password, salt, N, R, P);
  } catch {
    return false;
  }
  return timingSafeEqual(key, expected);
}

const DUMMY_SALT = Buffer.alloc(SALT_LEN, 1);

/** Burns the same time as a real check, so an unknown email is not distinguishable by timing. */
export async function dummyVerify(): Promise<void> {
  await derive("watchbell-dummy-password", DUMMY_SALT, N, R, P);
}

// 32 letters and digits without look-alikes (0/O, 1/l/I), so a byte & 31 picks one uniformly.
const TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const TEMP_PASSWORD_LENGTH = 20; // 100 bits

// A temporary password stops working this long after it was issued (sign-in and the password change refuse it).
export const TEMP_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const temporaryPasswordExpiry = (now: Date = new Date()): Date => new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);
export const TEMP_PASSWORD_EXPIRED = "This temporary password has expired. Ask an owner for a new one.";

/** A one-time password for a new member: shown once to the owner, changed at the member's first sign-in. */
export function newTemporaryPassword(): string {
  return Array.from(randomBytes(TEMP_PASSWORD_LENGTH), (b) => TEMP_ALPHABET[b & 31]).join("");
}
