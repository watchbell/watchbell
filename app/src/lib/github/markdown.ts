// GitHub → Repositories → README: markdown to a small tree the page renders as React elements (never as HTML: no
// dangerouslySetInnerHTML anywhere, React escapes every text). Pure.
// Safety: raw HTML is not rendered. <script>, <style>, <iframe> and friends are dropped with their content, <img> and
// <a> become markdown images and links, every other tag is removed and its text kept. Links are http(s) only (relative
// ones point at the file on github.com); images only from github.com or *.githubusercontent.com (a relative image of a
// public repository is read from raw.githubusercontent.com). Anything else keeps its text (a link) or its alt (an image).
// Bounded: the input is capped by the caller (200 KB), nesting depth is capped, every scan is linear.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "em" | "strong" | "del"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "img"; src: string; alt: string }
  | { t: "br" };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string | null; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: Inline[][]; rows: Inline[][][] };

export type MdContext = { fullName: string; ref: string; dir: string; isPrivate: boolean };

const MAX_DEPTH = 12;

// ---- URLs ----
const IMAGE_HOST = (host: string) => host === "github.com" || host === "githubusercontent.com" || host.endsWith(".githubusercontent.com");

// "docs/../img/a.png" from the README's folder → "img/a.png"; null when it climbs out of the repository.
export function joinPath(dir: string, rel: string): string | null {
  const out: string[] = rel.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of rel.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const pathPart = (p: string) => p.split("/").map((s) => encodeURIComponent(safeDecode(s))).join("/");
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// A link's target: an absolute http(s) URL as is, a relative path → the file on github.com, anything else (javascript:,
// data:, mailto:, an in-page #anchor) → null (the text is kept without a link).
export function safeHref(raw: string, ctx: MdContext): string | null {
  const v = raw.trim();
  if (!v || v.startsWith("#") || v.startsWith("//")) return null;
  if (SCHEME.test(v)) {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
      return null;
    }
  }
  const [path, hash] = v.split("#", 2);
  const joined = joinPath(ctx.dir, path.split("?")[0]);
  if (joined === null) return null;
  return `https://github.com/${pathPart(ctx.fullName)}/blob/${pathPart(ctx.ref)}/${pathPart(joined)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

// An image's source: https on github.com / *.githubusercontent.com, or a relative path of a public repository (read from
// raw.githubusercontent.com). Null otherwise: the page shows the alt text.
export function safeImage(raw: string, ctx: MdContext): string | null {
  const v = raw.trim();
  if (!v || v.startsWith("//")) return null;
  if (SCHEME.test(v)) {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && IMAGE_HOST(u.hostname.toLowerCase()) && !u.username && !u.password ? u.toString() : null;
    } catch {
      return null;
    }
  }
  if (ctx.isPrivate) return null;
  const joined = joinPath(ctx.dir, v.split("#")[0].split("?")[0]);
  return joined ? `https://raw.githubusercontent.com/${pathPart(ctx.fullName)}/${pathPart(ctx.ref)}/${pathPart(joined)}` : null;
}

// ---- raw HTML → markdown (outside code) ----
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", middot: "·", rarr: "→", larr: "←" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const mdText = (s: string) => s.replace(/[[\]()]/g, "");

// Raw HTML in prose: dangerous elements go with their content, <img>/<a>/<h1-6> become markdown, other tags vanish.
export function stripHtml(s: string): string {
  return s
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template|textarea|svg|math|form|select)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = attr(tag, "src");
      return src ? `![${mdText(attr(tag, "alt") ?? "")}](<${src.replace(/[<>\s]/g, "")}>)` : "";
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
      const href = attr(` ${attrs}`, "href");
      return href ? `[${inner}](<${href.replace(/[<>\s]/g, "")}>)` : inner;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inner.replace(/\n+/g, " ").trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|center|details|summary|picture|section|article|table|tr|ul|ol|li|blockquote)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, "");
}

// ---- blocks ----
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^( {0,3})([-*+])(\s+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)](\s+|$)(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const REF_DEF = /^ {0,3}\[([^\]]{1,200})\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/;

type Refs = Map<string, string>;
const refKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const startsBlock = (l: string) => FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || BULLET.test(l) || /^ {0,3}1[.)]\s/.test(l);

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length;

function parseBlocks(lines: string[], ctx: MdContext, refs: Refs, depth: number): Block[] {
  const out: Block[] = [];
  const inl = (s: string) => parseInline(s, ctx, refs, depth + 1);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (depth >= MAX_DEPTH) {
      out.push({ t: "p", c: [{ t: "text", v: lines.slice(i).join("\n") }] });
      break;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2] ? fence[2].slice(0, 30) : null, text: body.join("\n") });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: "h", level: atx[1].length as 1, c: inl(atx[2] ?? "") });
      i++;
      continue;
    }
    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "quote", c: parseBlocks(body, ctx, refs, depth + 1) });
      continue;
    }
    const first = BULLET.exec(line) ?? ORDERED.exec(line);
    if (first) {
      const ordered = !BULLET.test(line);
      const items: Block[][] = [];
      const start = ordered ? Number(first[2]) : 1;
      while (i < lines.length) {
        const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        const contentIndent = m[1].length + m[2].length + (ordered ? 1 : 0) + Math.max(1, Math.min(4, m[3].length));
        const body = [m[4]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line ends the item unless the next line is indented under it.
            const next = lines[i + 1];
            if (next !== undefined && next.trim() && indentOf(next) >= Math.min(contentIndent, 2)) { body.push(""); i++; continue; }
            break;
          }
          if (indentOf(l) >= Math.min(contentIndent, 2)) { body.push(l.slice(Math.min(indentOf(l), contentIndent))); i++; continue; }
          if (startsBlock(l) || ORDERED.test(l)) break;
          body.push(l.trim()); // lazy continuation
          i++;
        }
        items.push(parseBlocks(body, ctx, refs, depth + 1));
        if (i < lines.length && !lines[i].trim()) {
          const next = lines[i + 1];
          if (next !== undefined && (ordered ? ORDERED.test(next) : BULLET.test(next))) i++;
        }
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && rows.length < 500) rows.push(splitRow(lines[i++]).slice(0, head.length).map(inl));
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? null), head: head.map(inl), rows });
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].replace(/^( {4}|\t)/, ""));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push({ t: "code", lang: null, text: body.join("\n") });
      continue;
    }
    // A paragraph, or a setext heading when a === / --- line follows it.
    const para: string[] = [];
    let heading: 1 | 2 | null = null;
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (para.length && /^ {0,3}=+\s*$/.test(l)) { heading = 1; i++; break; }
      if (para.length && /^ {0,3}-+\s*$/.test(l)) { heading = 2; i++; break; }
      if (para.length && (startsBlock(l) || (l.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")))) break;
      para.push(l.trim());
      i++;
    }
    const text = para.join("\n");
    out.push(heading ? { t: "h", level: heading, c: inl(text) } : { t: "p", c: inl(text) });
  }
  return out;
}

// ---- inline ----
// The matching closer of a bracket that opens at `open`, skipping code spans and escapes; -1 when there is none.
function closing(s: string, open: number, o: string, c: string): number {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) { i = end + run.length - 1; continue; }
    }
    if (ch === o) level++;
    else if (ch === c && --level === 0) return i;
  }
  return -1;
}

// "(dest "title")" right after "]": the destination, and where the inline continues.
function destination(s: string, at: number): { dest: string; end: number } | null {
  if (s[at] !== "(") return null;
  const end = closing(s, at, "(", ")");
  if (end < 0) return null;
  const inner = s.slice(at + 1, end).trim();
  const dest = inner.startsWith("<") ? inner.slice(1, Math.max(1, inner.indexOf(">"))) : inner.split(/\s+/)[0] ?? "";
  return { dest, end: end + 1 };
}

const PUNCT = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^https?:\/\/[^\s<>"'`]+/i;

function parseInline(src: string, ctx: MdContext, refs: Refs, depth: number): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: decodeEntities(text) });
    text = "";
  };
  if (depth >= MAX_DEPTH) return [{ t: "text", v: decodeEntities(src) }];
  const s = src;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "\n") { flush(); out.push({ t: "br" }); i += 2; continue; }
      if (PUNCT.test(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
    }
    if (ch === "\n") {
      if (/ {2,}$/.test(text)) { text = text.replace(/ +$/, ""); flush(); out.push({ t: "br" }); } else text += " ";
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", v: s.slice(i + run.length, end).replace(/\n/g, " ").replace(/^ (.+) $/, "$1") });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    const image = ch === "!" && s[i + 1] === "[";
    if (ch === "[" || image) {
      const open = image ? i + 1 : i;
      const close = closing(s, open, "[", "]");
      if (close > 0) {
        const label = s.slice(open + 1, close);
        let target: string | null = null;
        let end = close + 1;
        const d = destination(s, close + 1);
        if (d) { target = d.dest; end = d.end; } else if (s[close + 1] === "[") {
          const rc = s.indexOf("]", close + 2);
          if (rc > 0) {
            target = refs.get(refKey(s.slice(close + 2, rc) || label)) ?? null;
            if (target !== null) end = rc + 1;
          }
        } else target = refs.get(refKey(label)) ?? null;
        if (target !== null) {
          flush();
          if (image) {
            const src2 = safeImage(target, ctx);
            const alt = decodeEntities(label.replace(/[*_`]/g, "")).trim();
            if (src2) out.push({ t: "img", src: src2, alt });
            else if (alt) out.push({ t: "text", v: alt });
          } else {
            const href = safeHref(target, ctx);
            const c = parseInline(label, ctx, refs, depth + 1);
            if (href) out.push({ t: "a", href, c });
            else out.push(...c);
          }
          i = end;
          continue;
        }
      }
    }
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        const href = safeHref(m[1], ctx);
        flush();
        out.push(href ? { t: "a", href, c: [{ t: "text", v: m[1] }] } : { t: "text", v: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = AUTOLINK.exec(s.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?)]+$/, "");
        const href = safeHref(url, ctx);
        flush();
        out.push(href ? { t: "a", href, c: [{ t: "text", v: url }] } : { t: "text", v: url });
        i += url.length;
        continue;
      }
    }
    if (ch === "~" && s[i + 1] === "~") {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "del", c: parseInline(s.slice(i + 2, end), ctx, refs, depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const double = s[i + 1] === ch;
      const mark = double ? ch + ch : ch;
      const prev = i > 0 ? s[i - 1] : " ";
      const next = s[i + mark.length] ?? " ";
      // "_" inside a word (snake_case) is text; an opener needs a non-space after it.
      const canOpen = !/\s/.test(next) && !(ch === "_" && /[A-Za-z0-9]/.test(prev));
      if (canOpen) {
        let end = -1;
        for (let k = i + mark.length + 1; k <= s.length - mark.length; k++) {
          if (s[k] === "\\") { k++; continue; }
          if (s[k] === "`") { const e2 = s.indexOf("`", k + 1); if (e2 > 0) { k = e2; continue; } }
          if (s.startsWith(mark, k) && !/\s/.test(s[k - 1]) && (mark.length === 2 || s[k + 1] !== ch) && !(ch === "_" && /[A-Za-z0-9]/.test(s[k + mark.length] ?? ""))) { end = k; break; }
        }
        if (end > 0) {
          flush();
          out.push({ t: double ? "strong" : "em", c: parseInline(s.slice(i + mark.length, end), ctx, refs, depth + 1) });
          i = end + mark.length;
          continue;
        }
      }
      text += mark;
      i += mark.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ---- the whole README ----
export const README_MAX_CHARS = 200 * 1024;

export function parseMarkdown(source: string, ctx: MdContext): Block[] {
  const lines = source.slice(0, README_MAX_CHARS).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  // Code blocks keep their text exactly; HTML is stripped from the prose between them, inline code spans protected.
  const refs: Refs = new Map();
  const prose: string[] = [];
  const out: string[] = [];
  let fence: string | null = null;
  const flushProse = () => {
    if (!prose.length) return;
    const codes: string[] = [];
    const joined = prose.join("\n").replace(/(`+)([^\n]*?[^`\n])\1(?!`)/g, (m) => `\u0000${codes.push(m) - 1}\u0000`);
    const cleaned = stripHtml(joined).replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[Number(n)] ?? "");
    for (const l of cleaned.split("\n")) {
      const def = REF_DEF.exec(l);
      if (def) { if (!refs.has(refKey(def[1]))) refs.set(refKey(def[1]), def[2]); continue; }
      out.push(l);
    }
    prose.length = 0;
  };
  for (const l of lines) {
    if (fence) {
      out.push(l);
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(l)) fence = null;
      continue;
    }
    const f = FENCE.exec(l);
    if (f) {
      flushProse();
      fence = f[1];
      out.push(l);
      continue;
    }
    prose.push(l);
  }
  flushProse();
  return parseBlocks(out, ctx, refs, 0);
}
