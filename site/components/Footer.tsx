import Link from "next/link";
import { chrome } from "@/content/chrome";
import { docsPath, type Lang } from "@/lib/paths";
import { GITHUB_URL, NPM_URL } from "@/lib/site";
import { Logo } from "./Header";

export function Footer({ lang }: { lang: Lang }) {
  const t = chrome[lang];
  return (
    <footer className="site-footer">
      <div className="wrap">
        <Logo lang={lang} label={t.home} />
        <nav>
          <a href={GITHUB_URL}>GitHub</a>
          <a href={NPM_URL}>npm</a>
          <Link href={docsPath(lang)}>{t.docs}</Link>
          <a href={`${GITHUB_URL}/blob/main/CHANGELOG.md`}>{t.changelog}</a>
          <a href={`${GITHUB_URL}/blob/main/SECURITY.md`}>{t.security}</a>
        </nav>
        <span className="legal">MIT © 2026 Trias · made in Indonesia</span>
      </div>
    </footer>
  );
}
