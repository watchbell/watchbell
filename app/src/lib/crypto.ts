import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealed = { ciphertext: string; iv: string; keyVersion: number };

const ALGORITHM = "aes-256-gcm";
const TAG_BYTES = 16;

function keyBytes(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded.");
  return key;
}

export function seal(plaintext: string, keyB64: string, keyVersion = 1): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBytes(keyB64), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"),
    iv: iv.toString("base64"),
    keyVersion,
  };
}

export function open(sealed: Pick<Sealed, "ciphertext" | "iv">, keyB64: string): string {
  const data = Buffer.from(sealed.ciphertext, "base64");
  if (data.length < TAG_BYTES) throw new Error("Stored credential is damaged.");
  const decipher = createDecipheriv(ALGORITHM, keyBytes(keyB64), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}

export function openOrNull(sealed: Pick<Sealed, "ciphertext" | "iv">, keyB64: string): string | null {
  try {
    return open(sealed, keyB64);
  } catch {
    return null;
  }
}
