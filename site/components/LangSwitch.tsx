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
  // A two-way switch: the current language is the pressed half, the other half is the link.
  const langs: Lang[] = ["en", "id"];
  return (
    <span className="lang" role="group" aria-label={label}>
      {langs.map((l) =>
        l === lang ? (
          <span key={l} aria-current="true">
            {l.toUpperCase()}
          </span>
        ) : (
          <a key={l} href={otherHref} hrefLang={l} lang={l} onClick={keepSection}>
            {l.toUpperCase()}
          </a>
        ),
      )}
    </span>
  );
}
