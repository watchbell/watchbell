import "server-only";
// U3/B2: the server half of heartbeats. Everything that needs node:crypto lives here, behind server-only, so no client
// component's import graph (the Uptime dialog imports @/lib/heartbeat) can pull a Node built-in or the token generator
// into a browser chunk.
import { createHash, randomBytes } from "node:crypto";

// Tokens are 128 random bits, shown once, stored as sha256 only.
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): { token: string; hash: string } {
  const token = `hb_${randomBytes(16).toString("hex")}`;
  return { token, hash: tokenHash(token) };
}

// A heartbeat's url column is "heartbeat:" + a slug of its name, so the (resource_id, url) unique index keeps one
// heartbeat of each name per app. Badge-style: lower case, letters and digits, single dashes. A name with no Latin
// letter or digit at all ("バックアップ") is keyed by a short hash of it instead, so it still gets a key of its own.
export function heartbeatKey(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `heartbeat:${slug || createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}
