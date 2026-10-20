import { createHash } from "node:crypto";

// Stage 9 slice 2: the SQL console's statement guard. It runs on the server before any connection is opened; the
// database then enforces the same thing again (a READ ONLY transaction, a read-only role, the extended protocol that
// refuses a second statement). This is a small tokenizer that follows Postgres's own lexing rules for the parts that
// can hide text: -- and nested /* */ comments, '…' strings (no backslash escapes, standard_conforming_strings), E'…'
// strings (backslash escapes), $tag$…$tag$ strings and "…" identifiers. Anything it can't lex with certainty (an
// unterminated string or comment) is refused.

export type Token =
  | { t: "word"; v: string } // lower-cased bare word (keyword or identifier)
  | { t: "qident"; v: string } // "quoted identifier", as written (case kept)
  | { t: "string" }
  | { t: "number" }
  | { t: "param" } // $1
  | { t: "punct"; v: string };

export type LexResult = { ok: true; tokens: Token[] } | { ok: false; error: string };

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export const MAX_SQL_CHARS = 20_000;

export function lex(src: string): LexResult {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  // A plain '…' string; `backslash` for E'…'. Returns the index after the closing quote, or -1.
  const quoted = (from: number, backslash: boolean): number => {
    let j = from + 1;
    while (j < n) {
      const c = src[j];
      if (backslash && c === "\\") { j += 2; continue; }
      if (c === "'") {
        if (src[j + 1] === "'") { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return -1;
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; } else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; } else i++;
      }
      if (depth > 0) return { ok: false, error: "A /* comment */ isn't closed." };
      continue;
    }
    if (c === "'") {
      const end = quoted(i, false);
      if (end < 0) return { ok: false, error: "A 'string' isn't closed." };
      out.push({ t: "string" });
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= n) return { ok: false, error: 'A "quoted name" isn\'t closed.' };
        if (src[j] === '"') {
          if (src[j + 1] === '"') { v += '"'; j += 2; continue; }
          break;
        }
        v += src[j++];
      }
      out.push({ t: "qident", v });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = DOLLAR_TAG.exec(src.slice(i, i + 200));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end < 0) return { ok: false, error: "A $$ string isn't closed." };
        out.push({ t: "string" });
        i = end + tag.length;
        continue;
      }
      if (/[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (i < n && /[0-9]/.test(src[i])) i++;
        out.push({ t: "param" });
        continue;
      }
      out.push({ t: "punct", v: "$" });
      i++;
      continue;
    }
    if (WORD_START.test(c)) {
      // String prefixes: E'…' (backslash escapes), U&'…', B'…', X'…', N'…'; U&"…" is a quoted identifier.
      const two = src.slice(i, i + 3);
      if (/^[eE]'/.test(two)) {
        const end = quoted(i + 1, true);
        if (end < 0) return { ok: false, error: "An E'string' isn't closed." };
        out.push({ t: "string" });
        i = end;
        continue;
      }
      if (/^[bBxXnN]'/.test(two)) {
        const end = quoted(i + 1, false);
        if (end < 0) return { ok: false, error: "A 'string' isn't closed." };
        out.push({ t: "string" });
        i = end;
        continue;
      }
      if (/^[uU]&'/.test(two)) {
        const end = quoted(i + 2, false);
        if (end < 0) return { ok: false, error: "A U&'string' isn't closed." };
        out.push({ t: "string" });
        i = end;
        continue;
      }
      if (/^[uU]&"/.test(two)) { i += 2; continue; } // the "…" that follows is lexed as a quoted identifier
      let j = i + 1;
      while (j < n && WORD_PART.test(src[j])) j++;
      out.push({ t: "word", v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9._a-zA-Z]/.test(src[j])) {
        if (/[eE]/.test(src[j]) && /[+-]/.test(src[j + 1] ?? "")) j++;
        j++;
      }
      out.push({ t: "number" });
      i = j;
      continue;
    }
    out.push({ t: "punct", v: c });
    i++;
  }
  return { ok: true, tokens: out };
}

// What a query may start with (after any opening parentheses).
const STARTS = new Set(["select", "with", "explain", "show", "table"]);

// Words that never belong in a read-only query, anywhere in it (outside strings, comments and "quoted names"):
// data-modifying CTEs, SELECT … INTO, EXPLAIN ANALYZE (it runs the statement), and statements that would change the
// session or the schema. A column really called one of these has to be written "quoted".
const DENY_WORDS = new Set([
  "insert", "update", "delete", "merge", "upsert", "into", "truncate", "copy",
  "analyze", "analyse",
  "create", "drop", "alter", "grant", "revoke",
  "set", "reset", "discard",
  "listen", "notify", "unlisten",
  "prepare", "execute", "deallocate",
  "vacuum", "cluster", "reindex", "checkpoint",
]);

// Functions with side effects a READ ONLY transaction doesn't stop (or that would lift our own timeouts), matched by
// name after any schema prefix: set_config could undo SET LOCAL statement_timeout; dblink and http reach other
// servers; the rest signal or read the server, take session locks, or run a query given as text.
const DENY_FUNCS = new Set([
  "set_config", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_switch_wal",
  "pg_create_restore_point", "pg_promote", "pg_stat_file", "pg_notify", "pg_logical_emit_message",
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema",
  "pg_import_system_collations", "pg_log_backend_memory_contexts", "pg_wal_replay_pause", "pg_wal_replay_resume",
]);
const DENY_FUNC_PREFIXES = ["dblink", "http", "pg_read_", "pg_ls_", "pg_advisory", "pg_try_advisory", "lo_", "pg_replication_", "pg_stat_reset", "pg_stat_statements_reset", "pg_create_", "pg_drop_", "pg_file_", "pg_backup_", "pg_start_backup", "pg_stop_backup"];

const deniedFunc = (name: string) => DENY_FUNCS.has(name) || DENY_FUNC_PREFIXES.some((p) => name.startsWith(p));

export type GuardResult =
  | { ok: true; text: string; kind: string }
  | { ok: false; error: string };

const isPunct = (t: Token | undefined, v: string) => t?.t === "punct" && t.v === v;
const isWord = (t: Token | undefined, ...v: string[]) => t?.t === "word" && v.includes(t.v);

export function guardSql(raw: unknown): GuardResult {
  if (typeof raw !== "string") return { ok: false, error: "Write a query first." };
  if (raw.length > MAX_SQL_CHARS) return { ok: false, error: `Keep the query under ${MAX_SQL_CHARS.toLocaleString("en")} characters.` };
  if (raw.includes("\u0000")) return { ok: false, error: "The query contains a null character." };
  const lexed = lex(raw);
  if (!lexed.ok) return lexed;
  let tokens = lexed.tokens;
  // One statement only: a trailing ; (or several) is fine, anything after one is a second statement.
  let last = tokens.length;
  while (last > 0 && isPunct(tokens[last - 1], ";")) last--;
  tokens = tokens.slice(0, last);
  if (!tokens.length) return { ok: false, error: "Write a query first." };
  if (tokens.some((t) => isPunct(t, ";"))) return { ok: false, error: "Run one statement at a time (nothing may follow a ;)." };
  let start = 0;
  while (isPunct(tokens[start], "(")) start++;
  const first = tokens[start];
  if (first?.t !== "word" || !STARTS.has(first.v)) {
    return { ok: false, error: "Only SELECT, WITH, EXPLAIN, SHOW and TABLE queries can run here." };
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "param") return { ok: false, error: "Parameters ($1) aren't supported. Write the value into the query." };
    if (t.t === "word" && DENY_WORDS.has(t.v)) {
      if (t.v === "analyze" || t.v === "analyse") return { ok: false, error: "EXPLAIN ANALYZE runs the statement, so it isn't allowed. Use plain EXPLAIN." };
      if (t.v === "into") return { ok: false, error: "SELECT … INTO creates a table, so it isn't allowed." };
      return { ok: false, error: `${t.v.toUpperCase()} isn't allowed: this console only reads.` };
    }
    // Row locks: FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE.
    if (isWord(t, "for") && isWord(tokens[i + 1], "update", "share", "no", "key")) {
      return { ok: false, error: "Row locks (FOR UPDATE / FOR SHARE) aren't allowed." };
    }
    if ((t.t === "word" || t.t === "qident") && isPunct(tokens[i + 1], "(")) {
      if (deniedFunc(t.v)) return { ok: false, error: `${t.v}() isn't allowed in the console.` };
    }
  }
  return { ok: true, text: raw.trim(), kind: first.v };
}

// The audit's stand-in for the query: a hash of its shape (words and punctuation, with every string, number and quoted
// name replaced), so the same query is recognisable across runs while no literal it contained (a token, an email, an
// id) ever reaches the events table.
export function sqlFingerprint(raw: string): string {
  const lexed = lex(raw);
  const shape = lexed.ok
    ? lexed.tokens.map((t) => (t.t === "word" ? t.v : t.t === "punct" ? t.v : "?")).join(" ")
    : "unlexable";
  return createHash("sha256").update(shape).digest("hex").slice(0, 12);
}
