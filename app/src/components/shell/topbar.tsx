"use client";

import { IconBell, IconEye, IconEyeOff, IconLayoutSidebar, IconSearch, IconTag } from "@tabler/icons-react";
import Link from "next/link";
import type { Ref } from "react";
import { usePrivacy } from "@/components/alias";
import { IconButton } from "@/components/kit";
import { LiveIndicator } from "@/components/live";
import { useSources } from "@/components/sources";
import { ThemeToggle } from "@/components/theme-toggle";
import type { DrawerLink } from "@/lib/extensions";
import type { Role } from "@/lib/roles";
import { ExtensionDrawer } from "./extension-drawer";
import { UserMenu } from "./user-menu";

export function Topbar({
  user, office, alerts, onToggleNav, onOpenPalette, navButtonRef,
}: { user: { email: string; role: Role; hasPassword?: boolean }; office?: DrawerLink; alerts: number; onToggleNav: () => void; onOpenPalette: (opener: HTMLElement) => void; navButtonRef?: Ref<HTMLButtonElement> }) {
  const { show, toggle } = useSources();
  const { shot, setShot } = usePrivacy();
  return (
    <header className="sticky top-0 z-20 flex h-[52px] items-center gap-2 border-b border-line bg-surface px-4">
      <IconButton ref={navButtonRef} label="Toggle navigation" onClick={onToggleNav}><IconLayoutSidebar size={18} /></IconButton>
      <button
        type="button"
        onClick={(e) => onOpenPalette(e.currentTarget)}
        aria-label="Search"
        aria-keyshortcuts="Control+K Meta+K"
        className="ml-2 flex w-[280px] items-center gap-2 whitespace-nowrap rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-ink-faint max-[720px]:w-auto"
      >
        <IconSearch size={16} />
        <span className="max-[720px]:hidden">Search apps, databases, pages</span>
        <kbd className="ml-auto rounded border border-line-strong px-[5px] font-mono text-[11px] text-ink-soft max-[720px]:hidden">Ctrl K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-0.5">
        {/* Screenshot mode: always visible while on, so it is never left on by accident; a click turns it off. */}
        {shot && (
          <button type="button" onClick={() => setShot(false)} title="Screenshot mode is on. Click to turn it off." aria-label="Screenshot mode is on. Turn it off"
            className="mr-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-warn/40 bg-warn-soft px-2.5 py-0.5 text-[12.5px] font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
            <IconEyeOff size={14} aria-hidden className="text-warn-icon" />
            <span className="max-[480px]:hidden">Screenshot mode</span>
          </button>
        )}
        <LiveIndicator />
        <IconButton label="Show data sources" pressed={show} onClick={toggle}><IconTag size={18} /></IconButton>
        {/* The extension's drawer: owner only (the layout sends `office` to owners alone; checked again here). */}
        {office && user.role === "owner" && <ExtensionDrawer link={office} />}
        <IconButton label="Screenshot mode" pressed={shot} onClick={() => setShot(!shot)}>{shot ? <IconEyeOff size={18} /> : <IconEye size={18} />}</IconButton>
        <ThemeToggle />
        <Link href="/alerts" aria-label={alerts ? `Alerts, ${alerts} firing` : "Alerts"} className="relative inline-grid size-[34px] place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink">
          <IconBell size={18} />
          {alerts > 0 && <span aria-hidden className="absolute right-0.5 top-[3px] rounded-[9px] bg-err px-1 font-mono text-[10px] font-medium leading-[15px] text-white">{alerts}</span>}
        </Link>
        <UserMenu email={user.email} role={user.role} hasPassword={user.hasPassword} />
      </div>
    </header>
  );
}
