// The documentation pages, read and rendered at build time.
//
// English pages come from docs/*.md (the reference), Indonesian ones from docs/id/*.md. Links are rewritten for the site
// (resolveDocLink) and any link that doesn't resolve stops the build. When an Indonesian page (or the whole docs/id
// folder) isn't there yet, its route shows a "translation coming" page instead (loadDocPage → kind "pending").

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Heading, Root as MdRoot, RootContent } from "mdast";
import { toString as mdToString } from "mdast-util-to-string";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { ASSET_PREFIX, findDocsSource } from "./docs-source.mjs";
import { docsPath, homePath, type Lang } from "./paths";
import { GITHUB_URL } from "./site";

export interface DocsSource {
  docsDir: string;
  idDir: string;
  repoRoot: string;
}

export interface DocHeading {
  depth: number;
  id: string;
  text: string;
}

/** A link in the docs that the site can't serve. Thrown during `next build`, so the build fails. */
export class DocLinkError extends Error {
  override name = "DocLinkError";
}

let defaultSource: DocsSource | undefined;
/** The docs next to this site (lib/docs-source.mjs), looked up once. */
export function getSource(): DocsSource {
  defaultSource ??= findDocsSource();
  return defaultSource;
}

const posix = (p: string) => p.split(path.sep).join("/");
const isInside = (dir: string, file: string) => {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** README.md → "" (the docs index), install.md → "install". */
export function slugOfFile(file: string): string {
  const base = path.basename(file, ".md");
  return base === "README" ? "" : base;
}

function fileOf(dir: string, slug: string): string {
  return path.join(dir, `${slug || "README"}.md`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Headings: GitHub's anchors, the same rule as public-edition/tests/docs.test.mjs (lower case, punctuation dropped,
// spaces to "-", repeats numbered -1, -2 …), so the links the repository test accepts are the ones the site accepts.

export function anchorBase(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

export function makeSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = anchorBase(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Links

export interface LinkContext {
  source: DocsSource;
  /** The page the link is on (absolute path). */
  fromFile: string;
  /** The language of that page: the project README goes to this language's home. */
  lang: Lang;
  /** The heading anchors of a docs file (absolute path). */
  anchorsOf: (file: string) => readonly string[];
}

/**
 * Where a link in a doc goes on the site. Paths resolve from the page's own folder, as on GitHub:
 * - `install.md#linux` → /docs/install#linux (from docs/) or /id/docs/install#linux (from docs/id/)
 * - the project README (`../README.md` from docs/, `../../README.md` from docs/id/) → the home of the page's language
 * - a file in docs/ that isn't Markdown (`images/x.png`) → /docs-assets/images/x.png (copied by scripts/copy-doc-assets)
 * - any other file in the repository (`../CONTRIBUTING.md`) → that file on GitHub
 * - http:, https: and mailto: → unchanged
 * Anything else (another scheme such as javascript: or data:, a protocol-relative //host link, a missing file or
 * heading, a path outside the repository) throws DocLinkError.
 */
/** The only URL schemes a doc may link to. The HTML is injected as is, so anything else could run script. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

export function resolveDocLink(href: string, ctx: LinkContext): string {
  const { docsDir, idDir, repoRoot } = ctx.source;
  const fail = (why: string) =>
    new DocLinkError(`${posix(path.relative(repoRoot, ctx.fromFile))}: the link "${href}" ${why}`);
  // Browsers ignore tabs and newlines inside a URL and leading spaces or control characters, so the scheme is read
  // without them: "java\tscript:" is still javascript:.
  const probe = href.replace(/[\u0000-\u0020]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1].toLowerCase();
  if (scheme !== undefined) {
    if (ALLOWED_SCHEMES.has(scheme)) return href;
    throw fail(`uses the ${scheme}: scheme; only http:, https: and mailto: links are allowed`);
  }
  if (probe.startsWith("//") || probe.startsWith("\\")) throw fail("has no scheme; write https:// in full");
  const at = href.indexOf("#");
  const filePart = at === -1 ? href : href.slice(0, at);
  const rawAnchor = at === -1 ? undefined : href.slice(at + 1);

  let anchor: string | undefined;
  let target: string;
  try {
    anchor = rawAnchor === undefined || rawAnchor === "" ? undefined : decodeURIComponent(rawAnchor);
    target = filePart === "" ? ctx.fromFile : path.resolve(path.dirname(ctx.fromFile), decodeURI(filePart));
  } catch {
    throw fail("is not a valid address");
  }
  const checkAnchor = (file: string) => {
    if (anchor !== undefined && !ctx.anchorsOf(file).includes(anchor)) {
      throw fail(`points to a heading that doesn't exist (#${anchor} in ${posix(path.relative(repoRoot, file))})`);
    }
  };

  if (filePart === "") {
    checkAnchor(ctx.fromFile);
    return anchor === undefined ? "#" : `#${anchor}`;
  }
  if (!isInside(repoRoot, target)) throw fail("points outside the repository");
  if (!fs.existsSync(target)) throw fail("points to a file that doesn't exist");

  if (target === path.join(repoRoot, "README.md")) return homePath(ctx.lang);
  const isMarkdown = target.toLowerCase().endsWith(".md");
  if (isMarkdown && path.dirname(target) === idDir) {
    checkAnchor(target);
    return docsPath("id", slugOfFile(target), anchor);
  }
  if (isMarkdown && path.dirname(target) === docsDir) {
    checkAnchor(target);
    return docsPath("en", slugOfFile(target), anchor);
  }
  const isFile = fs.statSync(target).isFile();
  if (isFile && !isMarkdown && isInside(docsDir, target)) return `${ASSET_PREFIX}/${posix(path.relative(docsDir, target))}`;
  return `${GITHUB_URL}/${isFile ? "blob" : "tree"}/main/${posix(path.relative(repoRoot, target))}${anchor ? `#${anchor}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing

interface Analysed {
  tree: MdRoot;
  title: string;
  headings: DocHeading[];
}

const analysed = new Map<string, Analysed>();

// "Bahasa Indonesia: [id/x.md](id/x.md)" at the top of an English page, "English: [../x.md](../x.md)" on an Indonesian
// one: the site has its own language switch, so the line is left out.
function isLanguageLine(node: RootContent): boolean {
  if (node.type !== "paragraph") return false;
  const kids = node.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
  return (
    kids.length === 2 &&
    kids[0].type === "text" &&
    /^(Bahasa Indonesia|English)\s*:$/.test(kids[0].value.trim()) &&
    kids[1].type === "link"
  );
}

/** Parses a docs file once: the Markdown tree (with heading ids set), the title (first # heading) and the headings. */
export function analyse(file: string): Analysed {
  const cached = analysed.get(file);
  if (cached) return cached;
  const text = fs.readFileSync(file, "utf8");
  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.runSync(processor.parse(text)) as MdRoot;

  tree.children = tree.children.filter((node, i) => !(i < 4 && isLanguageLine(node)));

  visit(tree, "html", (node, index, parent) => {
    if (node.value.trim().startsWith("<!--") && parent && index !== undefined) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
    const line = node.position?.start.line ?? "?";
    throw new DocLinkError(`${file}:${line}: raw HTML isn't rendered on the site; write it in Markdown`);
  });

  const slug = makeSlugger();
  const headings: DocHeading[] = [];
  visit(tree, "heading", (node: Heading) => {
    const label = mdToString(node);
    const id = slug(label);
    node.data = { ...node.data, hProperties: { ...(node.data?.hProperties ?? {}), id } };
    headings.push({ depth: node.depth, id, text: label });
  });
  const title = headings.find((h) => h.depth === 1)?.text ?? slugOfFile(file);
  const result = { tree, title, headings };
  analysed.set(file, result);
  return result;
}

export function anchorsOf(file: string): string[] {
  return analyse(file).headings.map((h) => h.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering

function text(value: string): ElementContent {
  return { type: "text", value };
}

function rewrite(tree: HastRoot, ctx: LinkContext) {
  visit(tree, "element", (node: Element, index, parent) => {
    const props = node.properties;
    if (node.tagName === "a" && typeof props.href === "string") {
      // Footnote links made by remark-gfm point at footnotes, not headings.
      if (props.dataFootnoteRef === undefined && props.dataFootnoteBackref === undefined) {
        props.href = resolveDocLink(props.href, ctx);
      }
    }
    if (node.tagName === "img" && typeof props.src === "string") {
      props.src = resolveDocLink(props.src, ctx);
      props.loading = "lazy";
    }
    if (/^h[2-4]$/.test(node.tagName) && typeof props.id === "string") {
      node.children.push({
        type: "element",
        tagName: "a",
        properties: { className: ["anchor"], href: `#${props.id}`, ariaHidden: "true", tabIndex: -1 },
        children: [text("#")],
      });
    }
    if (node.tagName === "table" && parent && index !== undefined) {
      // Wide tables scroll inside their own box, never the page.
      parent.children[index] = { type: "element", tagName: "div", properties: { className: ["table-wrap"] }, children: [node] };
      return SKIP;
    }
  });
}

export interface RenderedDoc {
  lang: Lang;
  slug: string;
  file: string;
  title: string;
  /** Plain-text summary for the page description: the first paragraph. */
  description: string;
  html: string;
  headings: DocHeading[];
  editUrl: string;
  /** YYYY-MM-DD of the last commit that touched the file, or null without git history. */
  updated: string | null;
}

const rendered = new Map<string, RenderedDoc>();

function lastUpdated(file: string, repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function renderDoc(file: string, lang: Lang, source: DocsSource): RenderedDoc {
  const cached = rendered.get(file);
  if (cached) return cached;
  const { tree, title, headings } = analyse(file);
  const hast = unified().use(remarkRehype).runSync(structuredClone(tree)) as HastRoot;
  rewrite(hast, { source, fromFile: file, lang, anchorsOf });
  const html = unified().use(rehypeStringify).stringify(hast);
  const firstParagraph = tree.children.find((n) => n.type === "paragraph");
  const doc: RenderedDoc = {
    lang,
    slug: slugOfFile(file),
    file,
    title,
    description: firstParagraph ? mdToString(firstParagraph).replace(/\s+/g, " ").slice(0, 200) : title,
    html,
    headings,
    editUrl: `${GITHUB_URL}/edit/main/docs/${posix(path.relative(source.docsDir, file))}`,
    updated: lastUpdated(file, source.repoRoot),
  };
  rendered.set(file, doc);
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pages

function markdownSlugs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => slugOfFile(f))
    .sort();
}

/** The slugs with a page under /docs/<slug> (English) or /id/docs/<slug> (every English page, plus any Indonesian one). */
export function docSlugs(lang: Lang, source: DocsSource = getSource()): string[] {
  const en = markdownSlugs(source.docsDir);
  if (lang === "en") return en;
  return [...new Set([...en, ...markdownSlugs(source.idDir)])].sort();
}

export type DocPage =
  | { kind: "doc"; doc: RenderedDoc; otherAnchors: string[]; otherHref: string }
  | { kind: "pending"; lang: Lang; slug: string; title: string; englishHref: string; otherHref: string };

/**
 * One docs route. `otherAnchors` are the twin page's heading anchors in the same order (both languages have the same
 * headings in number, level and order, so the language switch maps a #section by its position).
 * Returns null when there is no such page in either language.
 */
export function loadDocPage(lang: Lang, slug: string, source: DocsSource = getSource()): DocPage | null {
  const enFile = fileOf(source.docsDir, slug);
  const idFile = fileOf(source.idDir, slug);
  const file = lang === "en" ? enFile : idFile;
  const twin = lang === "en" ? idFile : enFile;
  const other: Lang = lang === "en" ? "id" : "en";
  const otherHref = docsPath(other, slug);
  if (fs.existsSync(file)) {
    return {
      kind: "doc",
      doc: renderDoc(file, lang, source),
      otherAnchors: fs.existsSync(twin) ? anchorsOf(twin) : [],
      otherHref,
    };
  }
  if (lang === "id" && fs.existsSync(enFile)) {
    return { kind: "pending", lang, slug, title: analyse(enFile).title, englishHref: docsPath("en", slug), otherHref };
  }
  return null;
}

export interface SidebarItem {
  title: string;
  slug: string;
  href: string;
  /** The words after the link in the index ("[Install](install.md): every way to install." → "every way to install."). */
  summary?: string;
}
export interface SidebarGroup {
  title: string | null;
  /** The id of the group's "##" heading in the rendered index, so the index page can find its section. */
  anchor?: string;
  items: SidebarItem[];
}

/**
 * The docs menu, from the docs index (README.md): its title first, then one group per "##" section with the pages its
 * lists link to. Sections that only link outside the docs ("Other files") are left out. The Indonesian menu comes from
 * docs/id/README.md, or from the English index (with /id links) until that exists.
 */
export function docsSidebar(lang: Lang, source: DocsSource = getSource()): SidebarGroup[] {
  const idIndex = fileOf(source.idDir, "");
  const index = lang === "id" && fs.existsSync(idIndex) ? idIndex : fileOf(source.docsDir, "");
  const { tree, title } = analyse(index);
  const groups: SidebarGroup[] = [{ title: null, items: [{ title, slug: "", href: docsPath(lang) }] }];
  let current: SidebarGroup | null = null;
  const seen = new Set<string>([""]);
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 2) {
      const anchor = (node.data?.hProperties as { id?: string } | undefined)?.id; // set by analyse()
      current = { title: mdToString(node), anchor, items: [] };
      groups.push(current);
    } else if (node.type === "list" && current) {
      for (const item of node.children) {
        let link: SidebarItem | null = null;
        visit(item, "link", (l) => {
          if (link) return;
          const m = /^([a-z0-9-]+)\.md(#.*)?$/i.exec(l.url);
          if (m && m[1] !== "README" && fs.existsSync(path.join(path.dirname(index), `${m[1]}.md`))) {
            link = { title: mdToString(l), slug: m[1], href: docsPath(lang, m[1]) };
          }
        });
        const found = link as SidebarItem | null;
        if (found && !seen.has(found.slug)) {
          seen.add(found.slug);
          const words = mdToString(item).trim();
          const rest = words.startsWith(found.title)
            ? words.slice(found.title.length).replace(/^\s*[:–—-]\s*/, "").replace(/\s+/g, " ")
            : "";
          if (rest) found.summary = rest;
          current.items.push(found);
        }
      }
    }
  }
  return groups.filter((g) => g.items.length > 0);
}
