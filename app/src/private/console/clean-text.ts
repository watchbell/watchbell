import { type AliasBook, hideEmails, realNames } from "@/lib/view/display-name";
import { scrubText as consoleScrub } from "@/private/console/scrub";
import { scrubText as mcpScrub } from "@/private/mcp/scrub";

// Free text the Kantor Virtual shows outside the console's own pages (the office's room alarms) or sends out (the
// Telegram copy of a report). Pure. The same two passes as the patrol's cleanText (patrol-data.ts): the console scrub
// (database names → db-a, account labels → account-1, keys, URLs → their path, every "@") and the MCP scrub (known hosts →
// app-a.example / site-a.example, vercel.app hosts, IPs, key-shaped tokens); then any host-shaped word still left (a
// monitor URL's host the alias book doesn't know yet) becomes "site.example", app names become their alias (app-a), and
// whatever email survived is hidden. Never a hostname, an email or a key.

const EDGE = "[\\p{L}\\p{N}_./-]"; // an app name only as a whole word, never inside a host or a path segment
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a.b.tld, sub.a.b.tld: letters in the last label (so "1.5" or "v2.3" stay); the aliases (*.example) are skipped.
const HOST = /(?<![\p{L}\p{N}_.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])/giu;

const appPatterns = new WeakMap<AliasBook, { re: RegExp; alias: Map<string, string> } | null>();
function appsOf(book: AliasBook) {
  if (appPatterns.has(book)) return appPatterns.get(book)!;
  const list = book.app.filter((a) => a.name.trim().length >= 2);
  const alias = new Map(list.map((a) => [a.name.toLowerCase(), a.alias]));
  const names = [...alias.keys()].sort((a, b) => b.length - a.length);
  const built = names.length ? { re: new RegExp(`(?<!${EDGE})(?:${names.map(escape).join("|")})(?!${EDGE})`, "giu"), alias } : null;
  appPatterns.set(book, built);
  return built;
}

export function aliasApps(text: string, book: AliasBook): string {
  const p = appsOf(book);
  return p ? text.replace(p.re, (m) => p.alias.get(m.toLowerCase()) ?? m) : text;
}

// One line or a block (line breaks kept): each line through every pass.
export function cleanOfficeText(text: string, book: AliasBook): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => {
    let out = mcpScrub(consoleScrub(line, book), book);
    out = out.replace(HOST, (h) => (/\.example$/i.test(h) ? h : "site.example"));
    return hideEmails(aliasApps(out, book));
  }).join("\n");
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
export const cleanLine = (text: string, book: AliasBook, max: number): string =>
  clip(cleanOfficeText(String(text ?? "").replace(/\s+/g, " "), book).replace(/\s+/g, " ").trim(), max);

// Watchbell 1.2.2 (D18): text for the owner's own Telegram chat. The same scrub (no key, email or URL; an unknown host
// is still "site.example"), then the real app, database and host names back in place of their aliases (realNames), so
// the auto-action and report notices name things the way the alert messages do. Never for a screen, Discord or a page.
export const ownerText = (text: string, book: AliasBook): string => realNames(cleanOfficeText(text, book), book);
export const ownerLine = (text: string, book: AliasBook, max: number): string =>
  clip(ownerText(String(text ?? "").replace(/\s+/g, " "), book).replace(/\s+/g, " ").trim(), max);
