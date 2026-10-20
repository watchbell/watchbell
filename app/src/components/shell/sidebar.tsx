"use client";

import { IconChevronRight } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type Ref, useState } from "react";
import type { ClientExtension } from "@/lib/extensions";
import { activeKey, visibleNav } from "@/lib/nav";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { CollectorStatus } from "./collector-status";
import { NAV_ICONS } from "./nav-icons";

export function Sidebar({
  role, ext, collector, alerts, mobileOpen, onNavigate, navRef,
}: { role: Role; ext: ClientExtension; collector: { lastRunAt: string | null; now: number; demo?: boolean }; alerts: number; mobileOpen: boolean; onNavigate: () => void; navRef?: Ref<HTMLElement> }) {
  const active = activeKey(usePathname(), ext);
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
        <span className="grid size-7 place-items-center rounded-[7px] bg-brand font-mono text-xs font-semibold text-on-brand">WB</span>
        <span>
          <b className="font-semibold">Watchbell</b>
          <small className="block text-xs text-ink-faint">Personal</small>
        </span>
      </Link>
      <div className="flex-1 px-2 pb-4 pt-2">
        {visibleNav(role, ext).map((g) => {
          const open = !closed[g.group];
          return (
            <div key={g.group} className="mt-1.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setClosed((c) => ({ ...c, [g.group]: open }))}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-ink-faint hover:text-ink"
              >
                {g.group}
                <IconChevronRight size={14} className={cn("ml-auto transition-transform", open && "rotate-90")} />
              </button>
              {open && (
                <ul>
                  {g.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon];
                    const on = item.key === active;
                    return (
                      <li key={item.key}>
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
