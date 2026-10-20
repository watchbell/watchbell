import { createHmac, randomInt } from "node:crypto";

/** No 0/O, 1/I/L: easy to read off a log line and type. */
export const SETUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SETUP_CODE_LENGTH = 10;

/** HMAC-SHA256 keyed with the decoded OPS_ENCRYPTION_KEY. Normalises what an owner typed. */
export function hashSetupCode(code: string, key: Uint8Array): string {
  const normalised = code.trim().toUpperCase().replace(/[-\s]/g, "");
  return createHmac("sha256", key).update(normalised).digest("hex");
}

export function newSetupCode(key: Uint8Array): { code: string; hash: string } {
  let code = "";
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) code += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  return { code, hash: hashSetupCode(code, key) };
}
