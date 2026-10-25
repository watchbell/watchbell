// URL helpers for the two languages. English is the reference at the root; Indonesian lives under /id.

export type Lang = "en" | "id";
export const LANGS: readonly Lang[] = ["en", "id"];

export function homePath(lang: Lang): string {
  return lang === "en" ? "/" : "/id";
}

/** /docs, /docs/install, /docs/install#linux, and the same under /id. */
export function docsPath(lang: Lang, slug = "", anchor?: string): string {
  const base = lang === "en" ? "/docs" : "/id/docs";
  const page = slug ? `${base}/${slug}` : base;
  return anchor ? `${page}#${anchor}` : page;
}

/**
 * The same page in the other language: / ↔ /id, /docs/<slug> ↔ /id/docs/<slug>. Any other path stays where it is. Accepts the forms a static host may show (trailing slash, .html, index.html).
 */
export function switchPath(pathname: string): string {
  let p = pathname.split(/[?#]/)[0] || "/";
  p = p.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "" || p === "/") return "/id";
  if (p === "/id") return "/";
  if (p.startsWith("/id/")) return p.slice(3);
  if (p === "/docs" || p.startsWith("/docs/")) return `/id${p}`;
  return p;
}

export function otherLang(lang: Lang): Lang {
  return lang === "en" ? "id" : "en";
}

/**
 * The same section on the twin page. Both languages have the same headings in number, level and order but their own
 * anchors (slugs of the translated text), so a section is matched by its position. "" when there is no match.
 */
export function mapAnchor(anchor: string, from: readonly string[], to: readonly string[]): string {
  const i = from.indexOf(anchor);
  return i >= 0 && i < to.length ? to[i] : "";
}
