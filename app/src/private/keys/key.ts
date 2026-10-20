import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_EXPIRY, EXPIRY_CHOICES, type ExpiryChoice, MAX_RATE_PER_MIN, SCOPES, type Scope } from "./scopes";

// Console API keys (R3): `wb_` + 40 characters from [A-Za-z0-9] (62^40, about 238 bits), shown once, stored as
// sha256(key) hex plus the first 7 characters (`wb_7Hq2`). Keys made before the Watchbell rename start with `wp_` and
// keep working forever (same length, same hash). Pure: no DB, no I/O.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const KEY_PREFIX = "wb_";
const KEY_RE = /^w[bp]_[A-Za-z0-9]{40}$/;
const BODY_LENGTH = 40;
// 248 = 4 * 62: a byte below it maps onto the alphabet without modulo bias; the rest are thrown away.
const UNBIASED_BELOW = 248;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newApiKey(): { key: string; hash: string; prefix: string } {
  let body = "";
  while (body.length < BODY_LENGTH) {
    for (const byte of randomBytes(BODY_LENGTH * 2)) {
      if (byte < UNBIASED_BELOW && body.length < BODY_LENGTH) body += ALPHABET[byte % ALPHABET.length];
    }
  }
  const key = `${KEY_PREFIX}${body}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 7) };
}

// `Authorization: Bearer wb_…` (or a legacy `wp_…`) only. The scheme is case-insensitive, extra spaces around are tolerated; anything else
// (another scheme, a `hb_` heartbeat token, a wrong length, trailing words) is not a console key.
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return m && KEY_RE.test(m[1]) ? m[1] : null;
}

export function hasScope(scopes: readonly Scope[], need: Scope | "any"): boolean {
  return need === "any" ? scopes.length > 0 : scopes.includes(need);
}

// The Create key form. Numbers arrive from FormData as strings, hence the coercion. `write:notes` is unticked by
// default in the dialog (scopes.ts DEFAULT_SCOPES), it is never added here.
export const keyFormSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]{2,40}$/, "Use 2–40 lowercase letters, digits or dashes."),
  scopes: z.array(z.enum(SCOPES)).min(1, "Pick at least one scope.").transform((s) => [...new Set(s)]),
  expiry: z.enum(EXPIRY_CHOICES).default(DEFAULT_EXPIRY),
  ratePerMin: z.coerce.number("Enter a whole number from 1 to 600.").int("Enter a whole number from 1 to 600.").min(1, "Enter a whole number from 1 to 600.").max(MAX_RATE_PER_MIN, "Enter a whole number from 1 to 600."),
});
export type KeyFormValues = z.infer<typeof keyFormSchema>;

export const renameSchema = keyFormSchema.shape.name;
export const rateSchema = keyFormSchema.shape.ratePerMin;

export function expiryDate(choice: ExpiryChoice, now: Date): Date | null {
  const day = 86_400_000;
  switch (choice) {
    case "7d": return new Date(now.getTime() + 7 * day);
    case "30d": return new Date(now.getTime() + 30 * day);
    case "90d": return new Date(now.getTime() + 90 * day);
    case "1y": {
      const d = new Date(now.getTime());
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    }
    case "never": return null;
  }
}

export type KeyStatus = "active" | "never-used" | "expired" | "revoked";

// Revoked wins over expired; a key that was never used is "never-used" until its first call.
export function keyStatus(k: { revokedAt: Date | null; expiresAt: Date | null; lastUsedAt: Date | null }, now: Date): KeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt.getTime() <= now.getTime()) return "expired";
  return k.lastUsedAt ? "active" : "never-used";
}
