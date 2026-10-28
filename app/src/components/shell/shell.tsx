"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AliasProvider } from "@/components/alias";
import { SourcesProvider } from "@/components/sources";
import type { ClientExtension } from "@/lib/extensions";
import type { Role } from "@/lib/roles";
import type { SectionId } from "@/lib/sections";
import { cn } from "@/lib/utils";
import type { AliasBook } from "@/lib/view/display-name";
import { CommandPalette } from "./command-palette";
import { DemoBanner } from "./demo-banner";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

const EMPTY_EXT: ClientExtension = { nav: [], palette: [] };

// `ext`: the private feature's nav groups and palette entries (5c), sent by the (console) layout to owners only.
// `collector.demo`: demo mode (WATCHBELL_MODE=demo), which also shows the demo banner above every page.
// `sections`: the sections that are on (lib/sections.ts); the sidebar and the palette list only their pages.
export function Shell({ user, collector, alerts, book, shot, ext = EMPTY_EXT, sections, children }: { user: { email: string; role: Role; hasPassword?: boolean }; collector: { lastRunAt: string | null; now: number; demo?: boolean; staleMs?: number }; alerts: number; book: AliasBook; shot: boolean; ext?: ClientExtension; sections?: SectionId[]; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteOpener, setPaletteOpener] = useState<Element | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      navRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      burgerRef.current?.focus();
    }
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  function openPalette(opener: Element | null) {
    setPaletteOpener(opener);
    setPaletteOpen(true);
  }

  function toggleNav() {
    if (window.matchMedia("(max-width: 1000px)").matches) setMobileOpen((v) => !v);
    else setCollapsed((v) => !v);
  }

  return (
    <AliasProvider book={book} shot={shot}>
      <SourcesProvider>
        <div className={cn("grid min-h-screen grid-cols-1", !collapsed && "min-[1001px]:grid-cols-[248px_minmax(0,1fr)]")}>
          {(!collapsed || mobileOpen) && <Sidebar role={user.role} ext={ext} sections={sections} collector={collector} alerts={alerts} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} navRef={navRef} />}
          {mobileOpen && (
            <button type="button" aria-label="Close navigation" className="fixed inset-0 z-40 bg-black/45 min-[1001px]:hidden" onClick={() => setMobileOpen(false)} />
          )}
          <main className="min-w-0">
            {collector.demo && <DemoBanner />}
            <Topbar user={user} office={ext.office} alerts={alerts} onToggleNav={toggleNav} onOpenPalette={openPalette} navButtonRef={burgerRef} />
            <div className="flex max-w-[1480px] flex-col gap-4 px-6 pb-10 pt-5 max-[720px]:px-3.5">{children}</div>
          </main>
        </div>
        <CommandPalette role={user.role} ext={ext} sections={sections} open={paletteOpen} opener={paletteOpener} onOpen={openPalette} onClose={() => setPaletteOpen(false)} />
      </SourcesProvider>
    </AliasProvider>
  );
}
