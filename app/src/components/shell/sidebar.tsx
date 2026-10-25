"use client";

import { BellMark } from "@/components/brand/bell-mark";
import { IconChevronRight } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, type Ref, useState } from "react";
import type { ClientExtension } from "@/lib/extensions";
import { activeKey, visibleNav } from "@/lib/nav";
import type { Role } from "@/lib/roles";
import type { SectionId } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { CollectorStatus } from "./collector-status";
import { NAV_ICONS } from "./nav-icons";

// Watchbell 1.2: one collapsible group per section that is on (`sections`, from the (console) layout; every section
// when it is missing), each page listed once; a sub-heading (DevOps › Automation) above the items that carry one.
export function Sidebar({
  role, ext, sections, collector, alerts, mobileOpen, onNavigate, navRef,
}: { role: Role; ext: ClientExtension; sections?: SectionId[]; collector: { lastRunAt: string | null; now: number; demo?: boolean }; alerts: number; mobileOpen: boolean; onNavigate: () => void; navRef?: Ref<HTMLElement> }) {
  // The search too, for the one item whose href has a query (Status page: /settings?tab=status-page). The console is
  // rendered per request (its layout reads cookies), so this never forces a client-side bailout of a prerender.
  const active = activeKey(usePathname(), ext, useSearchParams());
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  return (
    <nav
      ref={navRef}
      tabIndex={-1}
      aria-label="Main navigation"
      className={cn(
        "sticky top-0 flex h-screen flex-col overflow-y-auto border-r border-line bg-nav focus:outline-none",
        "max-[1000px]:fixed max-[1000px]:inset-y-0 max-[1000px]:left-0 max-[1000px]:z-50 max-[1000px]:w-[264px]",
        !mobileOpen && "max-[1000px]:invisible max-[1000px]:-translate-x-full",
      )}
    >
      <Link href="/" className="flex items-center gap-2.5 border-b border-line px-4 py-3.5 text-ink hover:no-underline">
        <BellMark />
        <span>
          <b className="font-semibold">Watchbell</b>
          <small className="block text-xs text-ink-faint">Personal</small>
        </span>
      </Link>
      <div className="flex-1 px-2 pb-4 pt-2">
        {visibleNav(role, ext, sections).map((g) => {
          const open = !closed[g.section];
          return (
            <div key={g.section} className="mt-1.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setClosed((c) => ({ ...c, [g.section]: open }))}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-ink-faint hover:text-ink"
              >
                {g.group}
                <IconChevronRight size={14} className={cn("ml-auto transition-transform", open && "rotate-90")} />
              </button>
              {open && (
                <ul>
                  {g.items.map((item, i) => {
                    const Icon = NAV_ICONS[item.icon];
                    const on = item.key === active;
                    const heading = item.sub && item.sub !== g.items[i - 1]?.sub ? item.sub : null;
                    return (
                      <Fragment key={item.key}>
                        {heading && <li aria-hidden className="px-2.5 pb-0.5 pt-1.5 text-[11px] uppercase tracking-[0.06em] text-ink-faint">{heading}</li>}
                        <li>
                          <Link
                            href={item.href}
                            onClick={onNavigate}
                            aria-current={on ? "page" : undefined}
                            className={cn(
                              "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-nav-text hover:bg-hover hover:no-underline",
                              on && "bg-nav-active font-medium text-nav-active-text",
                            )}
                          >
                            <Icon size={17} className={on ? "text-nav-active-text" : "text-ink-faint"} />
                            {item.label}
                            {item.key === "alerts" && alerts > 0 && <span className="ml-auto rounded-[10px] bg-err-soft px-1.5 font-mono text-[11px] font-medium text-err">{alerts}<span className="sr-only"> firing</span></span>}
                          </Link>
                        </li>
                      </Fragment>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <CollectorStatus initialLastRunAt={collector.lastRunAt} initialNow={collector.now} demo={collector.demo} />
    </nav>
  );
}
