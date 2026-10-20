import { createHash, timingSafeEqual } from "node:crypto";

// Constant time: both sides are hashed to the same length before comparing.
export function bearerOk(header: string | null, secret: string): boolean {
  if (!header || !secret || !header.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
