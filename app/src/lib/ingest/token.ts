import "server-only";
// Watchbell 1.8.6: the secret in an Alertmanager webhook URL (/api/alertmanager/{token}). 128 random bits written in
// base 58 (no 0, O, I or l to misread), shown once, stored as sha256 like heartbeat tokens.
import { randomBytes } from "node:crypto";
import { tokenHash } from "@/lib/heartbeat-token";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const INGEST_TOKEN = /^am_[1-9A-HJ-NP-Za-km-z]{22}$/;

// 16 bytes are below 58^22, so 22 digits always fit; leading zeros are written as "1" (base 58's zero).
function base58(bytes: Buffer): string {
  const ZERO = BigInt(0), BASE = BigInt(58);
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > ZERO) { out = B58[Number(n % BASE)] + out; n /= BASE; }
  return out.padStart(22, "1");
}

export function newIngestToken(): { token: string; hash: string; prefix: string } {
  const token = `am_${base58(randomBytes(16))}`;
  return { token, hash: tokenHash(token), prefix: token.slice(0, 7) };
}
