import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { chrome } from "@/content/chrome";
import { docsSidebar, loadDocPage, type DocPage, type SidebarGroup } from "@/lib/docs";
import { docsPath, type Lang } from "@/lib/paths";
import { Footer } from "./Footer";
import { Header } from "./Header";

// A docs page: the menu from the docs index, the rendered Markdown, and "Edit this page on GitHub". On phones the menu
// folds into a "Docs menu" disclosure above the page.

const PENDING = {
  title: "Terjemahan sedang disiapkan",
  lead: "Halaman ini belum diterjemahkan ke Bahasa Indonesia. Sementara itu, versi bahasa Inggrisnya sudah lengkap:",
  link: "Baca dalam bahasa Inggris →",
};

function Menu({ groups, slug }: { groups: SidebarGroup[]; slug: string }) {
  return (
    <>
      {groups.map((group, i) => (
        <div className="docs-group" key={group.title ?? i}>
          {group.title ? <p className="docs-group-title">{group.title}</p> : null}
          <ul>
            {group.items.map((item) => (
              <li key={item.slug}>
                <Link href={item.href} aria-current={item.slug === slug ? "page" : undefined}>
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The docs index: the README's own words, except that each menu section is laid out as a contents page (the page name
// on the left, what it covers on the right) instead of a bullet list of "Name: what it does" lines. A section that
// isn't in the menu ("Other files") stays as written.
function IndexBody({ html, groups }: { html: string; groups: SidebarGroup[] }) {
  const byAnchor = new Map(groups.filter((g) => g.anchor).map((g) => [g.anchor, g]));
  const parts = html.split(/(?=<h2[\s>])/);
  return (
    <article className="doc doc-index">
      {parts.map((part, i) => {
        const id = /^<h2 id="([^"]+)"/.exec(part)?.[1];
        const group = id ? byAnchor.get(id) : undefined;
        if (!group) return <div key={i} dangerouslySetInnerHTML={{ __html: part }} />;
        const heading = part.slice(0, part.indexOf("</h2>") + 5);
        return (
          <section key={i}>
            <div dangerouslySetInnerHTML={{ __html: heading }} />
            <ul className="toc">
              {group.items.map((item) => (
                <li key={item.slug}>
                  <Link href={item.href}>{item.title}</Link>
                  {item.summary ? <span>{capital(item.summary)}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </article>
  );
}

function load(lang: Lang, slug: string): DocPage {
  const page = loadDocPage(lang, slug);
  if (!page) notFound();
  return page;
}

export function docMetadata(lang: Lang, slug: string): Metadata {
  const page = load(lang, slug);
  const languages = { en: docsPath("en", slug), id: docsPath("id", slug) };
  if (page.kind === "pending") {
    return { title: `${PENDING.title}: ${page.title}`, robots: { index: false }, alternates: { languages } };
  }
  return {
    title: page.doc.title,
    description: page.doc.description,
    alternates: { canonical: docsPath(lang, slug), languages },
  };
}

export function DocsView({ lang, slug }: { lang: Lang; slug: string }) {
  const t = chrome[lang];
  const page = load(lang, slug);
  const groups = docsSidebar(lang);
  const anchors =
    page.kind === "doc" ? { own: page.doc.headings.map((h) => h.id), other: page.otherAnchors } : { own: [], other: [] };

  return (
    <>
      <Header lang={lang} otherHref={page.otherHref} anchors={anchors} />
      <div className="docs wrap">
        <details className="docs-menu">
          <summary>{t.docsMenu}</summary>
          <nav aria-label={t.onThisSite}>
            <Menu groups={groups} slug={slug} />
          </nav>
        </details>
        <aside className="docs-side">
          <nav aria-label={t.onThisSite}>
            <Menu groups={groups} slug={slug} />
          </nav>
        </aside>
        <main className="doc-main" id="main">
          {page.kind === "doc" ? (
            <>
              {slug === "" ? (
                <IndexBody html={page.doc.html} groups={groups} />
              ) : (
                <article className="doc" dangerouslySetInnerHTML={{ __html: page.doc.html }} />
              )}
              <div className="doc-foot">
                <a href={page.doc.editUrl}>{t.edit}</a>
                {page.doc.updated ? (
                  <span>
                    {t.updated} <time dateTime={page.doc.updated}>{page.doc.updated}</time>
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <article className="doc pending">
              <span className="eyebrow">{page.title}</span>
              <h1>{PENDING.title}</h1>
              <p>{PENDING.lead}</p>
              <p>
                <Link className="btn secondary" href={page.englishHref} hrefLang="en">
                  {PENDING.link}
                </Link>
              </p>
            </article>
          )}
        </main>
      </div>
      <Footer lang={lang} />
    </>
  );
}
