"use client";

import type { MouseEvent } from "react";
import { mapAnchor, type Lang } from "@/lib/paths";

export interface AnchorMap {
  /** This page's heading anchors, in order. */
  own: readonly string[];
  /** The twin page's heading anchors, in the same order. */
  other: readonly string[];
}

// EN / ID. The link goes to the same page in the other language. With JavaScript it also keeps the #section: on the
// home page the section ids are the same in both languages; on a docs page the heading at the same position is used
// (`anchors`), since each language has its own heading slugs.
export function LangSwitch({
  lang,
  otherHref,
  label,
  anchors,
}: {
  lang: Lang;
  otherHref: string;
  label: string;
  anchors?: AnchorMap;
}) {
  function keepSection(e: MouseEvent<HTMLAnchorElement>) {
    const hash = window.location.hash.slice(1);
    if (!hash || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    let section = hash;
    if (anchors) {
      let decoded = hash;
      try {
        decoded = decodeURIComponent(hash);
      } catch {
        // keep the raw hash
      }
      section = mapAnchor(decoded, anchors.own, anchors.other);
    }
    e.preventDefault();
    window.location.assign(section ? `${otherHref}#${encodeURIComponent(section)}` : otherHref);
  }
  const other: Lang = lang === "en" ? "id" : "en";
  const link = (
    <a href={otherHref} hrefLang={other} lang={other} onClick={keepSection}>
      {other.toUpperCase()}
    </a>
  );
  const current = <span aria-current="true">{lang.toUpperCase()}</span>;
  return (
    <span className="lang" role="group" aria-label={label}>
      {lang === "en" ? current : link}
      <span className="sep" aria-hidden="true">
        /
      </span>
      {lang === "en" ? link : current}
    </span>
  );
}
