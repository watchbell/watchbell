import Link from "next/link";
import { chrome } from "@/content/chrome";
import { docsPath, homePath, type Lang } from "@/lib/paths";
import { GITHUB_URL } from "@/lib/site";
import { BellMark } from "./BellMark";
import { LangSwitch, type AnchorMap } from "./LangSwitch";
import { ThemeToggle } from "./ThemeToggle";

export function Logo({ lang, label }: { lang: Lang; label: string }) {
  return (
    <Link className="logo" href={homePath(lang)} aria-label={label}>
      <span className="mark" aria-hidden="true">
        <BellMark />
      </span>
      Watchbell
    </Link>
  );
}

/**
 * The site header. `otherHref` is this page in the other language (`anchors` maps its sections on docs pages);
 * `onHome` keeps the section links on the page.
 */
export function Header({
  lang,
  otherHref,
  anchors,
  onHome = false,
}: {
  lang: Lang;
  otherHref: string;
  anchors?: AnchorMap;
  onHome?: boolean;
}) {
  const t = chrome[lang];
  const home = onHome ? "" : homePath(lang);
  return (
    <>
      {/* Every page's <main> has id="main". */}
      <a className="skip" href="#main">
        {t.skip}
      </a>
      <header className="nav">
        <div className="wrap">
          <Logo lang={lang} label={t.home} />
          <nav>
            <a href={`${home}#night`}>{t.night}</a>
            <a href={`${home}#board`}>{t.board}</a>
            <a href={`${home}#setup`}>{t.setup}</a>
            <Link href={docsPath(lang)}>{t.docs}</Link>
          </nav>
          <div className="right">
            <LangSwitch lang={lang} otherHref={otherHref} label={t.language} anchors={anchors} />
            <ThemeToggle label={t.theme} />
            <a className="iconbtn gh" href={GITHUB_URL} aria-label={t.github} title={t.github}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5" />
              </svg>
            </a>
          </div>
        </div>
      </header>
    </>
  );
}
