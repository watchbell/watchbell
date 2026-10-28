// Link mapping, the language switch and the "translation coming" fallback (plan 7, Task 3).
// Fixtures are written to site/.test-out (git-ignored) so nothing lands outside the site folder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anchorsOf,
  DocLinkError,
  docSlugs,
  docsSidebar,
  loadDocPage,
  renderDoc,
  resolveDocLink,
  type DocsSource,
  type LinkContext,
} from "./docs";
import { copyDocAssets, findDocsSource } from "./docs-source.mjs";
import { mapAnchor, switchPath } from "./paths";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(siteDir, ".test-out");

function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

const README_EN = `# Watchbell documentation

Bahasa Indonesia: [id/README.md](id/README.md)

See the [project README](../README.md#features).

## Start here

1. [Install](install.md): every way to install.
2. [FAQ](faq.md)

## Other files

- [Contributing](../CONTRIBUTING.md)
`;

const INSTALL_EN = `# Install

Bahasa Indonesia: [id/install.md](id/install.md)

Read the [FAQ](faq.md#is-it-free) or jump to [Linux](#linux).

![The overview](images/x.png)

## Linux

\`\`\`sh
npm install -g watchbell
\`\`\`

## Windows

| Option | What |
| --- | --- |
| \`--yes\` | no questions |
`;

const FAQ_EN = `# FAQ

Bahasa Indonesia: [id/faq.md](id/faq.md)

## Is it free?

Yes. Back to the [home page](../README.md).
`;

const README_ID = `# Dokumentasi Watchbell

English: [../README.md](../README.md)

Lihat [README proyek](../../README.md).

## Mulai di sini

1. [Instalasi](install.md): semua cara memasang.
2. [FAQ](faq.md)
`;

const INSTALL_ID = `# Instalasi

English: [../install.md](../install.md)

Baca [FAQ](faq.md#apakah-gratis), lompat ke [Linux](#linux), atau buka [versi bahasa Inggris](../install.md#windows).

![Ringkasan](../images/x.png)

## Linux

## Windows
`;

const FAQ_ID = `# FAQ

English: [../faq.md](../faq.md)

## Apakah gratis?

Ya. Kembali ke [beranda](../../README.md).
`;

let both: DocsSource;
let enOnly: DocsSource;

beforeAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  const common = {
    "README.md": "# Project\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "docs/README.md": README_EN,
    "docs/install.md": INSTALL_EN,
    "docs/faq.md": FAQ_EN,
    "docs/images/x.png": "not really a png",
  };
  write(path.join(scratch, "both"), {
    ...common,
    "docs/id/README.md": README_ID,
    "docs/id/install.md": INSTALL_ID,
    "docs/id/faq.md": FAQ_ID,
  });
  write(path.join(scratch, "en-only"), common);
  const source = (name: string): DocsSource => {
    const docsDir = path.join(scratch, name, "docs");
    return { docsDir, idDir: path.join(docsDir, "id"), repoRoot: path.join(scratch, name) };
  };
  both = source("both");
  enOnly = source("en-only");
});

function ctx(source: DocsSource, lang: "en" | "id", file: string): LinkContext {
  const fromFile = lang === "en" ? path.join(source.docsDir, file) : path.join(source.idDir, file);
  return { source, fromFile, lang, anchorsOf };
}

describe("resolveDocLink", () => {
  it("maps a page link with a section to the page in the same language", () => {
    expect(resolveDocLink("install.md#linux", ctx(both, "en", "faq.md"))).toBe("/docs/install#linux");
    expect(resolveDocLink("install.md#linux", ctx(both, "id", "faq.md"))).toBe("/id/docs/install#linux");
    expect(resolveDocLink("faq.md", ctx(both, "en", "install.md"))).toBe("/docs/faq");
    expect(resolveDocLink("README.md", ctx(both, "id", "faq.md"))).toBe("/id/docs");
  });

  it("checks the section against the target page's own headings", () => {
    expect(resolveDocLink("faq.md#is-it-free", ctx(both, "en", "install.md"))).toBe("/docs/faq#is-it-free");
    expect(resolveDocLink("faq.md#apakah-gratis", ctx(both, "id", "install.md"))).toBe("/id/docs/faq#apakah-gratis");
    expect(() => resolveDocLink("faq.md#is-it-free", ctx(both, "id", "install.md"))).toThrow(DocLinkError);
  });

  it("sends the project README to the home page of the page's language", () => {
    expect(resolveDocLink("../README.md", ctx(both, "en", "faq.md"))).toBe("/");
    expect(resolveDocLink("../README.md#features", ctx(both, "en", "README.md"))).toBe("/");
    expect(resolveDocLink("../../README.md", ctx(both, "id", "faq.md"))).toBe("/id");
  });

  it("keeps a link from an Indonesian page to an English one in English", () => {
    expect(resolveDocLink("../install.md#windows", ctx(both, "id", "install.md"))).toBe("/docs/install#windows");
  });

  it("serves images from the copied static files", () => {
    expect(resolveDocLink("images/x.png", ctx(both, "en", "install.md"))).toBe("/docs-assets/images/x.png");
    expect(resolveDocLink("../images/x.png", ctx(both, "id", "install.md"))).toBe("/docs-assets/images/x.png");
    const publicDir = path.join(scratch, "public");
    expect(copyDocAssets(both.docsDir, publicDir)).toEqual(["images/x.png"]);
    expect(fs.readFileSync(path.join(publicDir, "docs-assets", "images", "x.png"), "utf8")).toBe("not really a png");
  });

  it("links other repository files to GitHub and leaves web links alone", () => {
    expect(resolveDocLink("../CONTRIBUTING.md", ctx(both, "en", "README.md"))).toBe(
      "https://github.com/watchbell/watchbell/blob/main/CONTRIBUTING.md",
    );
    expect(resolveDocLink("https://nodejs.org", ctx(both, "en", "README.md"))).toBe("https://nodejs.org");
    expect(resolveDocLink("mailto:a@example.com", ctx(both, "en", "README.md"))).toBe("mailto:a@example.com");
  });

  it("keeps in-page sections that exist", () => {
    expect(resolveDocLink("#linux", ctx(both, "en", "install.md"))).toBe("#linux");
  });

  it("refuses links it can't serve (they fail the build)", () => {
    const c = ctx(both, "en", "install.md");
    expect(() => resolveDocLink("missing.md", c)).toThrow(/doesn't exist/);
    expect(() => resolveDocLink("install.md#nowhere", c)).toThrow(/heading that doesn't exist/);
    expect(() => resolveDocLink("#nowhere", c)).toThrow(DocLinkError);
    expect(() => resolveDocLink("../../outside.md", c)).toThrow(/outside the repository/);
  });

  it("allows only http:, https: and mailto: links (the rendered HTML is injected as is)", () => {
    const c = ctx(both, "en", "install.md");
    expect(resolveDocLink("HTTPS://nodejs.org", c)).toBe("HTTPS://nodejs.org");
    expect(resolveDocLink("http://localhost:3100", c)).toBe("http://localhost:3100");
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<b>x</b>",
      "vbscript:x",
      "file:///etc/passwd",
      "ftp://example.com",
    ]) {
      expect(() => resolveDocLink(bad, c), bad).toThrow(/only http:, https: and mailto:/);
    }
    expect(() => resolveDocLink("//evil.example/x", c)).toThrow(/has no scheme/);
  });

  it("fails the render of a page that links or embeds with another scheme", () => {
    write(path.join(scratch, "both"), {
      "docs/scheme.md": "# Scheme\n\n[x](javascript:alert(1))\n",
      "docs/scheme-img.md": "# Image\n\n![x](data:image/png;base64,AAAA)\n",
    });
    expect(() => renderDoc(path.join(both.docsDir, "scheme.md"), "en", both)).toThrow(/javascript: scheme/);
    expect(() => renderDoc(path.join(both.docsDir, "scheme-img.md"), "en", both)).toThrow(/data: scheme/);
    fs.rmSync(path.join(both.docsDir, "scheme.md"));
    fs.rmSync(path.join(both.docsDir, "scheme-img.md"));
  });

  it("fails the render of a page with a broken link", () => {
    write(path.join(scratch, "both"), { "docs/broken.md": "# Broken\n\nSee [nothing](nothing.md).\n" });
    expect(() => renderDoc(path.join(both.docsDir, "broken.md"), "en", both)).toThrow(/nothing\.md/);
    fs.rmSync(path.join(both.docsDir, "broken.md"));
  });
});

describe("rendering", () => {
  it("drops the language-link line and renders anchors, code and tables", () => {
    const doc = renderDoc(path.join(both.docsDir, "install.md"), "en", both);
    expect(doc.title).toBe("Install");
    expect(doc.html).not.toContain("Bahasa Indonesia:");
    expect(doc.html).toContain('<h2 id="linux">Linux<a class="anchor" href="#linux"');
    expect(doc.html).toContain('<pre><code class="language-sh">npm install -g watchbell');
    expect(doc.html).toContain('<div class="table-wrap"><table>');
    expect(doc.html).toContain('src="/docs-assets/images/x.png"');
    expect(doc.html).toContain('href="/docs/faq#is-it-free"');
    expect(doc.editUrl).toBe("https://github.com/watchbell/watchbell/edit/main/docs/install.md");
    const id = renderDoc(path.join(both.idDir, "install.md"), "id", both);
    expect(id.html).not.toContain("English:");
    expect(id.editUrl).toBe("https://github.com/watchbell/watchbell/edit/main/docs/id/install.md");
  });

  it("builds the menu from the docs index of each language", () => {
    expect(docsSidebar("en", both)).toEqual([
      { title: null, items: [{ title: "Watchbell documentation", slug: "", href: "/docs" }] },
      {
        title: "Start here",
        anchor: "start-here",
        items: [
          { title: "Install", slug: "install", href: "/docs/install", summary: "every way to install." },
          { title: "FAQ", slug: "faq", href: "/docs/faq" },
        ],
      },
    ]);
    expect(docsSidebar("id", both)[1]).toEqual({
      title: "Mulai di sini",
      anchor: "mulai-di-sini",
      items: [
        { title: "Instalasi", slug: "install", href: "/id/docs/install", summary: "semua cara memasang." },
        { title: "FAQ", slug: "faq", href: "/id/docs/faq" },
      ],
    });
  });
});

describe("language switch", () => {
  it("maps /docs/<slug> to /id/docs/<slug> and back", () => {
    expect(switchPath("/docs/install")).toBe("/id/docs/install");
    expect(switchPath("/id/docs/install")).toBe("/docs/install");
    expect(switchPath("/docs")).toBe("/id/docs");
    expect(switchPath("/id/docs/")).toBe("/docs");
    expect(switchPath("/docs/install.html")).toBe("/id/docs/install");
    expect(switchPath("/")).toBe("/id");
    expect(switchPath("/id")).toBe("/");
    expect(switchPath("/elsewhere")).toBe("/elsewhere");
  });

  it("lands on the same section by position", () => {
    const page = loadDocPage("en", "install", both);
    expect(page?.kind).toBe("doc");
    if (page?.kind !== "doc") return;
    expect(page.otherHref).toBe("/id/docs/install");
    const own = page.doc.headings.map((h) => h.id);
    expect(own).toEqual(["install", "linux", "windows"]);
    expect(page.otherAnchors).toEqual(["instalasi", "linux", "windows"]);
    expect(mapAnchor("install", own, page.otherAnchors)).toBe("instalasi");
    expect(mapAnchor("windows", own, page.otherAnchors)).toBe("windows");
    expect(mapAnchor("nowhere", own, page.otherAnchors)).toBe("");
  });
});

describe("Indonesian fallback", () => {
  it("shows 'translation coming' pages when docs/id is missing", () => {
    expect(docSlugs("id", enOnly)).toEqual(docSlugs("en", enOnly));
    expect(docSlugs("en", enOnly)).toEqual(["faq", "install"]);
    expect(loadDocPage("id", "install", enOnly)).toEqual({
      kind: "pending",
      lang: "id",
      slug: "install",
      title: "Install",
      englishHref: "/docs/install",
      otherHref: "/docs/install",
    });
    expect(loadDocPage("id", "", enOnly)?.kind).toBe("pending");
    expect(docsSidebar("id", enOnly)[1].items[0]).toEqual({
      title: "Install",
      slug: "install",
      href: "/id/docs/install",
      summary: "every way to install.",
    });
    const en = loadDocPage("en", "install", enOnly);
    expect(en?.kind === "doc" && en.otherAnchors).toEqual([]);
  });

  it("renders the Indonesian page once it is there", () => {
    const page = loadDocPage("id", "install", both);
    expect(page?.kind).toBe("doc");
    expect(page?.kind === "doc" && page.doc.title).toBe("Instalasi");
    expect(loadDocPage("id", "nothing", both)).toBeNull();
  });
});

describe("the real docs", () => {
  it("are found next to the site and every page renders (no broken links)", () => {
    const source = findDocsSource(siteDir);
    for (const lang of ["en", "id"] as const) {
      for (const slug of ["", ...docSlugs(lang, source)]) {
        const page = loadDocPage(lang, slug, source);
        expect(page, `${lang} ${slug}`).not.toBeNull();
      }
    }
  });
});

// The site reads the docs from ../public-edition/docs in the private tree and from ../docs in the exported public
// repository (scripts/export: public-edition/ lands at the root). Both must work, and must give the same pages.
describe("where the docs are found", () => {
  const layouts = path.join(scratch, "layouts");
  let savedEnv: string | undefined;

  beforeAll(() => {
    savedEnv = process.env.WATCHBELL_DOCS_DIR;
    delete process.env.WATCHBELL_DOCS_DIR;
    fs.rmSync(layouts, { recursive: true, force: true });
    write(path.join(layouts, "public"), { "README.md": "# Project\n", "docs/README.md": "# Docs\n", "site/.keep": "" });
    write(path.join(layouts, "private"), {
      "README.md": "# Private project\n",
      "docs/README.md": "# Internal notes, never on the site\n",
      "public-edition/README.md": "# Project\n",
      "public-edition/docs/README.md": "# Docs\n",
      "site/.keep": "",
    });
    write(path.join(layouts, "none"), { "site/.keep": "" });
    return () => {
      if (savedEnv === undefined) delete process.env.WATCHBELL_DOCS_DIR;
      else process.env.WATCHBELL_DOCS_DIR = savedEnv;
    };
  });

  it("uses ../docs in the exported public repository", () => {
    const root = path.join(layouts, "public");
    expect(findDocsSource(path.join(root, "site"))).toEqual({
      docsDir: path.join(root, "docs"),
      idDir: path.join(root, "docs", "id"),
      repoRoot: root,
    });
  });

  it("prefers ../public-edition/docs in the private tree, whose own docs/ is internal", () => {
    const root = path.join(layouts, "private", "public-edition");
    expect(findDocsSource(path.join(layouts, "private", "site"))).toEqual({
      docsDir: path.join(root, "docs"),
      idDir: path.join(root, "docs", "id"),
      repoRoot: root,
    });
  });

  it("honours WATCHBELL_DOCS_DIR and fails clearly when there are no docs", () => {
    process.env.WATCHBELL_DOCS_DIR = path.join(layouts, "public", "docs");
    try {
      expect(findDocsSource(path.join(layouts, "none", "site")).repoRoot).toBe(path.join(layouts, "public"));
    } finally {
      delete process.env.WATCHBELL_DOCS_DIR;
    }
    expect(() => findDocsSource(path.join(layouts, "none", "site"))).toThrow(/Documentation not found/);
  });

  // In the private tree, copy public-edition/ the way the export lays it out (its files at the repository root, the site
  // beside docs/) and render every real page there. Inside an export the real docs are already in that layout, and the
  // "real docs" test above covers it.
  const real = findDocsSource(siteDir);
  const privateTree = path.basename(real.repoRoot) === "public-edition";
  it.skipIf(!privateTree)("render the same pages in the exported layout, links included", () => {
    const root = path.join(layouts, "exported");
    fs.cpSync(real.repoRoot, root, { recursive: true });
    fs.mkdirSync(path.join(root, "site"), { recursive: true });
    const exported = findDocsSource(path.join(root, "site"));
    expect(exported.docsDir).toBe(path.join(root, "docs"));
    let pages = 0;
    for (const lang of ["en", "id"] as const) {
      expect(docSlugs(lang, exported)).toEqual(docSlugs(lang, real));
      for (const slug of ["", ...docSlugs(lang, real)]) {
        const a = loadDocPage(lang, slug, real);
        const b = loadDocPage(lang, slug, exported);
        expect(b?.kind, `${lang} ${slug}`).toBe(a?.kind);
        if (a?.kind === "doc" && b?.kind === "doc") {
          expect(b.doc.html, `${lang} ${slug}`).toBe(a.doc.html);
          expect(b.doc.editUrl).toBe(a.doc.editUrl);
          expect(b.otherAnchors).toEqual(a.otherAnchors);
          pages++;
        }
      }
    }
    expect(pages).toBeGreaterThanOrEqual(26);
  });
});
