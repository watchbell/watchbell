# Watchbell website

The public site for Watchbell: the home page in English (`/`) and Bahasa Indonesia (`/id`), the documentation
(`/docs/<page>` and `/id/docs/<page>`), served at https://watchbell.west-solutions.web.id. There is no public demo. It is
a small Next.js 16 app with `output: "export"`, so `next build` writes plain HTML, CSS and JavaScript to `out/` (with
`sitemap.xml` and `robots.txt`) and nothing runs on a server.

## Build and preview

Node.js 24, from this folder:

```sh
npm ci
npm run build      # writes out/
npm run preview    # serves out/ at http://localhost:3200 the way Vercel does (clean URLs, 404.html)
npm test           # link mapping, language switch, the "translation coming" fallback, text contrast, version
```

`npm run dev` starts the dev server on port 3200 while you edit. `npm run lint` and `npm run typecheck` are the other
checks. `npm run build` and `npm run dev` first copy the docs' images to `public/docs-assets/` (git-ignored).

## Where things are

| Path | What it is |
| --- | --- |
| `app/(en)/`, `app/(id)/id/` | The two languages, each with its own root layout (so `<html lang>` is right) |
| `app/styles.css` | The approved mockup's styles; colours are the console's tokens (`app/src/app/globals.css`). Text uses `--ink`, `--ink-soft` or `--ink-mute` (at least 4.5:1 in both themes); `--ink-faint` is for decoration only, and `lib/contrast.test.ts` checks both |
| `app/icon.svg` | The favicon: the header's bell mark |
| `lib/version.ts` | The version in the home page's terminal sample: the first `## x.y.z` heading of `CHANGELOG.md`, read at build time |
| `components/Home.tsx` | The home page sections; the words are in `content/home.en.tsx` and `content/home.id.tsx` |
| `lib/site.ts` | The site's address (`SITE_URL`: metadataBase, canonical URLs, sitemap, robots.txt) and the GitHub and npm links |
| `app/sitemap.ts`, `app/robots.ts` | `sitemap.xml` (both home pages and every docs page, with their language twins) and `robots.txt`, written at build time |
| `lib/docs.ts` | Reads and renders the docs at build time: links, heading anchors, the docs menu, the fallback |
| `app/(en)/docs/`, `app/(id)/id/docs/` | The docs routes, one static page per Markdown file |

Light and dark follow the visitor's system setting; the header toggle overrides it and is remembered in that browser.

## Documentation pages

The pages are the repository's own Markdown: `docs/*.md` (English, the reference) and `docs/id/*.md` (Indonesian), read
from `../docs` in the public repository or `../public-edition/docs` in the private tree (`WATCHBELL_DOCS_DIR` overrides
both). `README.md` is `/docs`; `install.md` is `/docs/install` and `/id/docs/install`.

- Links resolve from the page's folder, as on GitHub: another page (with its `#section`) becomes its site address in the
  same language, the project README becomes the home page of that language, images under `docs/` are served from
  `/docs-assets/`, and any other file in the repository links to it on GitHub. A link to a file or heading that doesn't
  exist, raw HTML, a path outside the repository, or a URL scheme other than `http:`, `https:` and `mailto:` stops the
  build.
- Headings get GitHub's anchors. Each language has its own (they are slugs of the translated text), so the language
  switch keeps you on the same section by its position: both languages have the same headings in the same order.
- The "Bahasa Indonesia: …" / "English: …" line at the top of each file is left out; the header has the switch.
- An Indonesian page that isn't there yet (or a missing `docs/id/`) shows "Terjemahan sedang disiapkan" with a link to
  the English page, and the build still succeeds.
- Each page links to "Edit this page on GitHub" and shows the date of the last commit that touched it (when the build has
  git history).

## Deploying on Vercel

Documentation only: creating the project, adding domains and DNS records happen with the owner's OK (plan 7, Tasks 5
and 6).

| Setting | Value |
| --- | --- |
| Project | `watchbell-site` (Vercel Hobby) |
| Framework preset | Next.js |
| Root directory | `site` |
| Build command | `npm run build` (the default) |
| Output directory | `out` |
| Install command | `npm ci` (the default) |
| Environment variables | none (`NEXT_TELEMETRY_DISABLED=1` is optional) |
| Domain | `watchbell.west-solutions.web.id` (Cloudflare record DNS-only, grey cloud, so Vercel issues the certificate) |

`vercel.json` turns on clean URLs (`/docs/install` serves `docs/install.html`), sends a trailing-slash address such as
`/docs/` or `/id/` to the address without it (the export writes `docs.html` next to a `docs/` folder, with no
`index.html` inside). `package.json` pins Node 24 (`engines`). If the address changes, change `SITE_URL` in
`lib/site.ts`.
