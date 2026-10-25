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
            <ThemeToggle label={t.theme} title={t.themeLabel} />
            <a className="gh" href={GITHUB_URL}>
              {t.github}
            </a>
          </div>
        </div>
      </header>
    </>
  );
}
