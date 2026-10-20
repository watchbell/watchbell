"use client";

import { IconChevronDown, IconDotsVertical } from "@tabler/icons-react";
import { useState } from "react";
import { buttonClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// `disabled`: why the item can't be used right now (stage 6, e.g. "No previous production deployment"), shown next to
// its label like a later stage (a disabled item gets no pointer events, so a title tooltip would never appear).
export type MenuEntry = "---" | { label: string; onSelect?: () => void; href?: string; later?: number; danger?: boolean; disabled?: string };

// The mockup's kebab ("Actions", ti-dots-vertical) and the app page's "Actions ▾" button. A separator is "---";
// Delete/Remove items are red; items that arrive in a later stage are disabled with their stage; links open in a new
// tab (the surface and items follow the mockup's .menu). While the menu is open the page doesn't refresh under it.
// `label` is the kebab's accessible name ("Actions for shortly"), so a screen reader can tell the rows apart.
// With `button` it is the button's text instead ("Actions", or "Open in" on the app page).
export function RowMenu({ items, button = false, label = "Actions" }: { items: MenuEntry[]; button?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  useHoldRefresh(open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {button ? (
        <DropdownMenuTrigger className={buttonClass()}>{label} <IconChevronDown size={16} aria-hidden /></DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger aria-label={label} className="rounded-[5px] px-1.5 py-1 text-ink-faint hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
          <IconDotsVertical size={17} />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="min-w-[200px] rounded-[8px] border border-line-strong bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,.14)] ring-0">
        {items.map((item, i) => item === "---" ? <DropdownMenuSeparator key={`sep-${i}`} /> : (
          <DropdownMenuItem
            key={item.label}
            disabled={item.later !== undefined || item.disabled !== undefined}
            variant={item.danger ? "destructive" : "default"}
            className="rounded-[5px] px-2.5 py-[7px]"
            onClick={() => {
              if (item.href) window.open(item.href, "_blank", "noopener,noreferrer");
              else item.onSelect?.();
            }}
          >
            {item.label}
            {item.later !== undefined && <span className="ml-auto pl-3 text-[11px] text-ink-faint">Arrives in stage {item.later}</span>}
            {item.later === undefined && item.disabled !== undefined && <span className="ml-auto pl-3 text-[11px] text-ink-faint">{item.disabled}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
