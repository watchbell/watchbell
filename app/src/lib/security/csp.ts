import { themeInitScript } from "@/lib/theme";
import { STATIC_HTML_PATHS } from "./static-html";

// Watchbell 1.2.1 (audit hardening list 3): a Content-Security-Policy with a per-request nonce. It shipped Report-Only
// first; a click-through of every page on 24 Oct showed no violation, so it is enforced. It carries frame-ancestors too,
// so next.config.ts only keeps X-Frame-Options for the files the proxy doesn't see (images, _next/static).
//
// How the nonce reaches the page (Next 16, docs 01-app/02-guides/content-security-policy.md): the proxy puts the policy
// on the REQUEST headers; Next reads the nonce from the request's script-src while rendering a dynamic page and adds it
// to its own scripts. The theme script in the root layout is allowed by its sha256 instead (reading the nonce there
// would make every page dynamic, the ISR status pages included). Pages rendered ahead of time (the public status pages
// /s/…) can't carry a nonce, so they get a policy without one.

export const CSP_HEADER = "Content-Security-Policy";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

let themeHash: string | null = null;
export async function themeScriptHash(): Promise<string> {
  if (!themeHash) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(themeInitScript));
    themeHash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
  }
  return themeHash;
}

// nonce null: a page rendered ahead of time (no nonce possible), so inline scripts are allowed there.
// staticFile: one of STATIC_HTML_PATHS (the office), which the console frames itself (same origin, as next.config.ts
// allows) and which loads Google Fonts (review T2b-fix m-3). Every page may frame its own origin (the office drawer).
export function cspHeader(o: { nonce: string | null; themeHash: string; dev: boolean; staticFile?: boolean }): string {
  const script = o.nonce
    ? ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", o.themeHash]
    : ["'self'", "'unsafe-inline'"];
  if (o.dev) script.push("'unsafe-eval'"); // React's dev tooling; never in production
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `style-src 'self' 'unsafe-inline'${o.staticFile ? " https://fonts.googleapis.com" : ""}`,
    "img-src 'self' data: https:",
    `font-src 'self' data:${o.staticFile ? " https://fonts.gstatic.com" : ""}`,
    `connect-src 'self'${o.dev ? " ws: wss:" : ""}`,
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-ancestors ${o.staticFile ? "'self'" : "'none'"}`,
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// Paths whose HTML is rendered ahead of time or is a static file: the public status pages (ISR; an unmatched /s/… path
// falls to the root not-found, which shows no console data) and the listed static HTML in public/ (the office page, with
// its own inline script). Never a suffix match: the console's dynamic pages answer any path, "/apps/x.html" too.
export const isPrerenderedPath = (path: string): boolean => path.startsWith("/s/") || STATIC_HTML_PATHS.includes(path);
