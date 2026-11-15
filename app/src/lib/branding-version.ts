import { createHash } from "node:crypto";

// Watchbell 1.7.1 (review M-9): a stored logo's version, the first 12 hex characters of its SHA-256. Pages ask for
// /brand-icon?v=<version>, so the CDN can keep the picture and a new logo gets a new address. Server only (node:crypto);
// lib/branding.ts stays importable from the browser.
export const logoVersionOf = (png: Uint8Array): string => createHash("sha256").update(png).digest("hex").slice(0, 12);
