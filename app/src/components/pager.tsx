"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/kit";
import { cn } from "@/lib/utils";

// The mockup's pager: a footer row under a long list. The range on the left, "‹ Previous" / "Next ›" on the right,
// each disabled at its end. Nothing at all when everything fits on one page.
// `bleed` is for a list inside a padded Card body (Events): the rule runs edge to edge and the text lines up with the
// rows, like the mockup's `.card-body .pager`. In a flush Card (tables) leave it off.
export function Pager({ page, pages, text, onPage, bleed = false }: { page: number; pages: number; text: string; onPage: (page: number) => void; bleed?: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const focusAfter = useRef<0 | 1 | null>(null);
  // A button that disables itself (Next onto the last page, Previous onto the first) would drop focus on <body>.
  // After the page changes, focus goes to the other button, which is enabled by then.
  useEffect(() => {
    if (focusAfter.current === null) return;
    box.current?.querySelectorAll("button")[focusAfter.current]?.focus();
    focusAfter.current = null;
  }, [page]);
  if (pages <= 1) return null;
  const step = (to: number, other: 0 | 1) => {
    if (to <= 1 || to >= pages) focusAfter.current = other;
    onPage(to);
  };
  return (
    <div className={cn("flex items-center gap-2 border-t border-line px-[18px] py-2.5 text-[12.5px] text-ink-soft", bleed ? "-mx-[18px] -mb-4 mt-2" : "max-[720px]:px-3.5")}>
      <span role="status">{text}</span>
      <span ref={box} className="ml-auto flex gap-1.5">
        <Button size="sm" className="disabled:hover:bg-surface" aria-label="Previous page" disabled={page <= 1} onClick={() => step(page - 1, 1)}>‹ Previous</Button>
        <Button size="sm" className="disabled:hover:bg-surface" aria-label="Next page" disabled={page >= pages} onClick={() => step(page + 1, 0)}>Next ›</Button>
      </span>
    </div>
  );
}
