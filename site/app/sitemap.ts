import fs from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { docSlugs, getSource } from "@/lib/docs";
import { docsPath, homePath } from "@/lib/paths";
import { SITE_URL } from "@/lib/site";

// sitemap.xml, written once at build time (static export): both home pages and every docs page. An Indonesian docs page
// that is still "translation coming" (noindex) is left out; its English twin is listed.
export const dynamic = "force-static";

const url = (p: string) => `${SITE_URL}${p === "/" ? "" : p}`;

export default function sitemap(): MetadataRoute.Sitemap {
  const source = getSource();
  const translated = (slug: string) => fs.existsSync(path.join(source.idDir, `${slug || "README"}.md`));

  const entries: MetadataRoute.Sitemap = [];
  const pair = (en: string, id: string | null) => {
    const languages = id ? { en: url(en), id: url(id) } : undefined;
    entries.push({ url: url(en), alternates: languages && { languages } });
    if (id) entries.push({ url: url(id), alternates: { languages: languages! } });
  };

  pair(homePath("en"), homePath("id"));
  for (const slug of ["", ...docSlugs("en", source)]) {
    pair(docsPath("en", slug), translated(slug) ? docsPath("id", slug) : null);
  }
  return entries;
}
