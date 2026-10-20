// Privacy (owner, 13 Oct 2026): the console is screenshotted for WhatsApp status and the portfolio, so no screen and no
// notification shows a database's real name or an email address.
// - Every database (Supabase, Neon, Firebase) is shown as a stable alias, db-a, db-b, …; a click on it shows the real
//   name for that one element (components/alias.tsx).
// - The letters follow one deterministic order, first_seen_at then id, over every database row the console has ever
//   synced (watched or not, gone or not), so db-a is the same database on every page, in every notification and after
//   a refresh. A new database only ever gets the next letter.
// - Text built from names (events, alerts, Advisor items, banners, the digest, Telegram and Discord) goes through
//   hideNames: each database name becomes its alias, and any email left becomes "[email hidden]".
// The real name stays in the database and is still what matching, links and Sync use. Pure: safe for client code.

export type Alias = { id: string; name: string; alias: string };
// `app` is lettered too (app-a, …): screenshot mode masks apps, and a database named like an app keeps its name in
// free text (see hideNames). Screenshot mode also uses `account` (account-1, …, by when it was added) and `host`
// (an app's domains app-a.example, app-a-2.example; its vercel.app host; zones and other domains site-a.example) and
// `team` (Vercel team slugs, team-1, …, by their first app: the A6 sentence names the team, stage 6 minor M5).
export type AliasBook = { db: Alias[]; app: Alias[]; account?: Alias[]; host?: Alias[]; team?: Alias[] };
// `team`: an app row's Vercel team slug (resources.meta.teamSlug), ignored on other kinds.
export type AliasRow = { id: string; kind: string; name: string; firstSeenAt: Date | string; parentId?: string | null; team?: string | null };
export type AccountRow = { id: string; label: string; createdAt: Date | string };

export const EMPTY_BOOK: AliasBook = { db: [], app: [] };
export const EMAIL_HIDDEN = "[email hidden]";
// Screenshot mode's per-browser cookie ("1" = on), written by the topbar toggle and read by the console layout.
export const SHOT_COOKIE = "oc-shot";

const DB_KINDS = new Set(["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database", "db", "fs"]);
export const isDbKind = (kind: string | null | undefined): boolean => kind != null && DB_KINDS.has(kind);

// 0 → a, 25 → z, 26 → aa, 27 → ab … (bijective base 26, so no letter sequence is skipped or repeated).
export function aliasLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const time = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();

const byFirstSeen = (a: AliasRow, b: AliasRow) => time(a.firstSeenAt) - time(b.firstSeenAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function letter(rows: AliasRow[], prefix: string): Alias[] {
  return [...rows].sort(byFirstSeen).map((r, i) => ({ id: r.id, name: r.name, alias: `${prefix}-${aliasLetters(i)}` }));
}

function hosts(rows: AliasRow[], apps: Alias[]): Alias[] {
  const out: Alias[] = [];
  const taken = new Set<string>();
  const add = (id: string, name: string, alias: string) => {
    const key = name.toLowerCase();
    if (taken.has(key)) return;
    taken.add(key);
    out.push({ id, name: key, alias });
  };
  const appOf = new Map(apps.map((a) => [a.id, a]));
  const domains = rows.filter((r) => r.kind === "domain").sort(byFirstSeen);
  const count = new Map<string, number>();
  for (const d of domains) {
    const app = d.parentId ? appOf.get(d.parentId) : undefined;
    if (!app) continue;
    const n = (count.get(app.id) ?? 0) + 1;
    count.set(app.id, n);
    add(d.id, d.name, `${app.alias}${n > 1 ? `-${n}` : ""}.example`);
  }
  for (const a of apps) add(`${a.id}:vercel`, `${a.name}.vercel.app`, `${a.alias}${count.has(a.id) ? "-vercel" : ""}.example`);
  const sites = rows.filter((r) => r.kind === "zone" || (r.kind === "domain" && !(r.parentId && appOf.has(r.parentId))))
    .sort(byFirstSeen).filter((r) => !taken.has(r.name.toLowerCase()));
  sites.forEach((r, i) => add(r.id, r.name, `site-${aliasLetters(i)}.example`));
  return out;
}

function teams(apps: AliasRow[]): Alias[] {
  const out: Alias[] = [];
  for (const a of [...apps].sort(byFirstSeen)) {
    const slug = a.team?.trim();
    if (slug && !out.some((t) => t.name === slug)) out.push({ id: `team:${slug}`, name: slug, alias: `team-${out.length + 1}` });
  }
  return out;
}

export function buildAliasBook(rows: AliasRow[], accounts: AccountRow[] = []): AliasBook {
  const appRows = rows.filter((r) => r.kind === "app");
  const app = letter(appRows, "app");
  const account = [...accounts].sort((a, b) => time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a, i) => ({ id: a.id, name: a.label, alias: `account-${i + 1}` }));
  return { db: letter(rows.filter((r) => isDbKind(r.kind)), "db"), app, account, host: hosts(rows, app), team: teams(appRows) };
}

export const appAlias = (book: AliasBook, name: string): string => book.app.find((a) => a.name === name)?.alias ?? "app-?";
export const accountAlias = (book: AliasBook, label: string): string => book.account?.find((a) => a.name === label)?.alias ?? "account-?";

// A database the book doesn't know yet (synced after the book was read) still never shows its name.
export function dbAlias(book: AliasBook, id: string): string {
  return book.db.find((d) => d.id === id)?.alias ?? "db-?";
}

// An address with a dotted domain: "someone@gmail.com", "a.b+c@sub.example.co.id".
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}/gu;

export function hideEmails(text: string): string {
  return text.replace(EMAIL, EMAIL_HIDDEN);
}

export function displayName(r: { id: string; kind: string; name: string }, book: AliasBook): string {
  return isDbKind(r.kind) ? dbAlias(book, r.id) : hideEmails(r.name);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name counts only as a whole: not inside a longer word ("ticketerx", "my-ticketer", "ticketer_2").
const EDGE = "[\\p{L}\\p{N}_-]";
const patterns = new WeakMap<AliasBook, { re: RegExp; alias: Map<string, string> } | null>();

function patternOf(book: AliasBook) {
  if (patterns.has(book)) return patterns.get(book)!;
  // Longest first, so "ticketer-staging" wins over "ticketer". A one-letter name would eat every "a" in a sentence.
  // A database named like an app (the console suggests links by matching names) stays as it is in free text: the text
  // may be about the app ("ticketer · Deployment ready"), and the app is shown under that name anyway.
  const apps = new Set(book.app.map((a) => a.name.toLowerCase()));
  const names = [...new Set(book.db.map((d) => d.name).filter((n) => n.trim().length >= 2 && !apps.has(n.toLowerCase())))].sort((a, b) => b.length - a.length);
  const alias = new Map<string, string>();
  for (const d of book.db) if (!alias.has(d.name.toLowerCase())) alias.set(d.name.toLowerCase(), d.alias);
  const built = names.length ? { re: new RegExp(`(?<!${EDGE})(?:${names.map(escape).join("|")})(?!${EDGE})`, "giu"), alias } : null;
  patterns.set(book, built);
  return built;
}

const wholeName = (name: string) => new RegExp(`(?<!${EDGE})${escape(name)}(?!${EDGE})`, "giu");

// `about`: the resource the text is about (an event's or alert's resource). When it is a database, its own name is
// replaced first, even if an app shares it ("Supabase project portfolio is paused.").
export function hideNames(text: string, book: AliasBook, about?: string | null): string;
export function hideNames(text: string | null, book: AliasBook, about?: string | null): string | null;
export function hideNames(text: string | null, book: AliasBook, about?: string | null): string | null {
  if (!text) return text;
  const own = about ? book.db.find((d) => d.id === about) : undefined;
  let out = own && own.name.trim().length >= 2 ? text.replace(wholeName(own.name), own.alias) : text;
  const p = patternOf(book);
  if (p) out = out.replace(p.re, (m) => p.alias.get(m.toLowerCase()) ?? m);
  return hideEmails(out);
}

// An Advisor item as the pages show it. The key stays (Dismiss sends it back); an unlinked database is named by its id.
export function hideRec<R extends { key: string; subject: string; title: string; why: string; fix: string }>(r: R, book: AliasBook): R {
  const unlinked = /^db-unlinked:(.+)$/.exec(r.key)?.[1];
  return {
    ...r,
    subject: unlinked ? dbAlias(book, unlinked) : hideNames(r.subject, book),
    title: hideNames(r.title, book, unlinked), why: hideNames(r.why, book, unlinked), fix: hideNames(r.fix, book, unlinked),
  };
}

// What a table's filter searches: what is shown plus the real names behind it, so either one finds the row.
export function searchText(shown: (string | null | undefined)[], real: (string | null | undefined)[] = []): string {
  return [...shown, ...real].filter((s): s is string => !!s).join(" ");
}

const isDbOf = (book: AliasBook, id: string | null | undefined): id is string => !!id && book.db.some((d) => d.id === id);

// An event as Overview and Events show it (stored rows too, whatever they say).
export function hideEvent<E extends { resource: string; resourceId: string | null; message: string; detail: string | null }>(e: E, book: AliasBook): E {
  return {
    ...e,
    resource: isDbOf(book, e.resourceId) ? dbAlias(book, e.resourceId) : hideNames(e.resource, book),
    message: hideNames(e.message, book, e.resourceId), detail: hideNames(e.detail, book, e.resourceId),
  };
}

// An alert as the Alerts page and the notifications show it. A database's alert is titled by the database's name.
export function hideAlert<A extends { title: string; message: string; causedBy: string | null; resourceId: string | null }>(a: A, book: AliasBook): A {
  return {
    ...a,
    title: isDbOf(book, a.resourceId) ? dbAlias(book, a.resourceId) : hideNames(a.title, book, a.resourceId),
    message: hideNames(a.message, book, a.resourceId), causedBy: hideNames(a.causedBy, book),
  };
}

// ---- Screenshot mode (Part 2) ------------------------------------------------------------------------------------
// maskText: what any text looks like while screenshot mode is on. In order: emails; known hosts (an app's domain, a
// zone, with any subdomain and the path kept: "api.example.com/x" → "api.site-a.example/x"); any other vercel.app host
// ("preview.example", it carries the team's name); any other URL's host ("site.example"); then whole app, database
// and account names. Only text masking: links, copy buttons and forms keep the real values.

// Before a host or a name: not a letter, digit, "_", "." or "-" (so "api.example.com" is caught by its subdomain group,
// and "app-a.example" or "account-1" written here are never matched again). After one: not a letter, digit, "_" or
// "-", and no ".x" (a longer host or a file name). Sentence dots stay fine.
const BEFORE = String.raw`[\p{L}\p{N}_.-]`;
const AFTER = String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`;
const masks = new WeakMap<AliasBook, { host: RegExp | null; hostAlias: Map<string, string>; names: RegExp | null; nameAlias: Map<string, string> }>();

function masksOf(book: AliasBook) {
  const hit = masks.get(book);
  if (hit) return hit;
  const hostList = [...(book.host ?? [])].sort((a, b) => b.name.length - a.name.length);
  const hostAlias = new Map(hostList.map((h) => [h.name.toLowerCase(), h.alias]));
  const host = hostList.length
    ? new RegExp(String.raw`(?<!${BEFORE})((?:[a-z0-9-]+\.)*?)(${hostList.map((h) => escape(h.name)).join("|")})${AFTER}`, "giu")
    : null;
  const nameAlias = new Map<string, string>();
  for (const list of [book.app, book.db, book.account ?? [], book.team ?? []]) {
    for (const a of list) if (a.name.trim().length >= 2 && !nameAlias.has(a.name.toLowerCase())) nameAlias.set(a.name.toLowerCase(), a.alias);
  }
  const names = nameAlias.size
    ? new RegExp(`(?<!${BEFORE})(?:${[...nameAlias.keys()].sort((a, b) => b.length - a.length).map(escape).join("|")})${AFTER}`, "giu")
    : null;
  const built = { host, hostAlias, names, nameAlias };
  masks.set(book, built);
  return built;
}

const VERCEL_HOST = /(?<![\p{L}\p{N}_.-])[a-z0-9-]+\.vercel\.app(?![\p{L}\p{N}_-])/giu;
const URL_HOST = /(https?:\/\/)([^\s/?#"'<>]+)/giu;

export function maskText(text: string, book: AliasBook): string {
  if (!text) return text;
  const m = masksOf(book);
  let out = hideEmails(text);
  if (m.host) out = out.replace(m.host, (_all, sub: string, h: string) => `${sub}${m.hostAlias.get(h.toLowerCase()) ?? h}`);
  out = out.replace(VERCEL_HOST, "preview.example");
  out = out.replace(URL_HOST, (all, scheme: string, h: string) => (/\.example$/i.test(h) ? all : `${scheme}site.example`));
  if (m.names) out = out.replace(m.names, (n) => m.nameAlias.get(n.toLowerCase()) ?? n);
  return out;
}
