import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes, base32 without padding. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, email: string, issuer = "Watchbell"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const query = Object.entries({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `otpauth://totp/${label}?${query}`;
}

function codeForStep(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Checks a 6-digit code against the steps now-1, now and now+1.
 * `now` is epoch milliseconds. A step at or before `lastStep` is rejected (replay).
 * On success returns the matched step; the caller must store it as the new lastStep.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: number,
  lastStep: number | null | undefined,
): { ok: true; step: number } | { ok: false } {
  if (!Number.isFinite(now)) return { ok: false };
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return { ok: false };
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return { ok: false };
  }
  // An empty or tiny key would make every code trivially computable.
  if (key.length < 16) return { ok: false };
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  const givenBuf = Buffer.from(given);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const same = timingSafeEqual(Buffer.from(codeForStep(key, step)), givenBuf);
    if (same && matched === null && (lastStep == null || step > lastStep)) matched = step;
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}
