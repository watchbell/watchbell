import { scrubLog } from "@/lib/logs/scrub";
import { type AliasBook, hideNames } from "@/lib/view/display-name";

// R5 (5c): everything the console hands to an agent (/api/v1/status, /api/v1/advice, the MCP read tools, the console's
// own AI prompts) goes through scrubText. Pure. On top of the console's own privacy rules (database names → db-a,
// emails hidden, scrubLog's secret masks) it removes what an agent never needs: account labels (→ account-1), URLs
// (only the path is kept), provider and console keys, and every "@".
//
// Substrings that must never appear in a snapshot's JSON (the leak tests assert it).
export const LEAK_PATTERNS = ["@", "://", "postgres", "wb_", "wp_", "hb_", "sk-", "gsk_", "AIza"] as const;

const SECRET = /(?<![\p{L}\p{N}_])(?:w[bp]_[A-Za-z0-9]{6,}|hb_[0-9a-f]{6,}|sk-[A-Za-z0-9_-]{6,}|gsk_[A-Za-z0-9]{6,}|AIza[0-9A-Za-z_-]{8,}|AQ\.[A-Za-z0-9_-]{8,})/gu;
// scheme://authority, then an optional path, then an optional query or fragment.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>)]*(\/[^\s?#"'<>)]*)?(?:[?#][^\s"'<>)]*)?/gi;
const EDGE = "[\\p{L}\\p{N}_-]";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const accountPatterns = new WeakMap<AliasBook, { re: RegExp; alias: Map<string, string> } | null>();

function accountsOf(book: AliasBook) {
  if (accountPatterns.has(book)) return accountPatterns.get(book)!;
  const list = (book.account ?? []).filter((a) => a.name.trim().length >= 2);
  const alias = new Map(list.map((a) => [a.name.toLowerCase(), a.alias]));
  const names = [...alias.keys()].sort((a, b) => b.length - a.length);
  const built = names.length ? { re: new RegExp(`(?<!${EDGE})(?:${names.map(escape).join("|")})(?!${EDGE})`, "giu"), alias } : null;
  accountPatterns.set(book, built);
  return built;
}

// Shapes that mean "this text carries a credential" (refused, not masked: Ask Antigravity, POST /api/v1/ai/questions).
// SECRET's key prefixes plus scrubLog's credential rules (bearer tokens, JWTs, user:password@ in a URL, long hex or
// key-like runs). Not "key=value" or emails: a person asking about a password error or an address is fine.
const CREDENTIAL_SHAPES: RegExp[] = [
  new RegExp(SECRET.source, "u"),
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\b[A-Fa-f0-9]{40,}\b/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/,
];

export function looksLikeSecret(text: string): boolean {
  return CREDENTIAL_SHAPES.some((re) => re.test(text));
}

export function scrubText(text: string, book: AliasBook): string {
  let out = scrubLog(text);
  out = hideNames(out, book);
  const acc = accountsOf(book);
  if (acc) out = out.replace(acc.re, (m) => acc.alias.get(m.toLowerCase()) ?? m);
  out = out.replace(SECRET, "[hidden]");
  out = out.replace(/hb_\[hidden\]/g, "[hidden]");
  out = out.replace(URL_RE, (_all, path: string | undefined) => path ?? "[url]");
  return out.replace(/@/g, "(at)");
}
