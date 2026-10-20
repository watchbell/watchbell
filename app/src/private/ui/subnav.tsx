"use client";

import {
  IconApi, IconBox, IconChartBar, IconGauge, IconKey, IconLayoutDashboard, IconListDetails, IconLock, IconMessage, IconMessageQuestion, IconPlugConnected, IconRobot,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const AI_SUBS: { key: string; label: string; href: string; icon: TablerIcon }[] = [
  { key: "overview", label: "Overview", href: "/ai", icon: IconLayoutDashboard },
  { key: "usage", label: "Usage", href: "/ai/usage", icon: IconChartBar },
  { key: "ask", label: "Ask", href: "/ai/ask", icon: IconMessageQuestion },
  { key: "keys", label: "API keys", href: "/ai/keys", icon: IconKey },
  { key: "agents", label: "Agents", href: "/ai/agents", icon: IconRobot },
  { key: "connect", label: "Connect an agent", href: "/ai/connect", icon: IconPlugConnected },
  { key: "providers", label: "Bring your own key", href: "/ai/providers", icon: IconLock },
  { key: "quota", label: "Quota", href: "/ai/quota", icon: IconGauge },
  { key: "logs", label: "Logs", href: "/ai/logs", icon: IconListDetails },
  { key: "models", label: "Models", href: "/ai/models", icon: IconBox },
  { key: "playground", label: "Playground", href: "/ai/playground", icon: IconMessage },
];

// Which sub-page a path belongs to ("/ai/keys/x" → "keys", "/ai" → "overview").
export function activeSub(pathname: string): string {
  const seg = pathname.replace(/\/+$/, "").split("/")[2];
  return AI_SUBS.some((s) => s.key === seg) ? seg : "overview";
}

const link = "flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-ink-soft hover:bg-hover hover:text-ink hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

// The mockup's left menu of the AI Gateway (.subnav), with the API explorer link under a rule. `active` overrides the
// path-based choice; by default it follows the URL.
export function AiSubnav({ active }: { active?: string }) {
  const pathname = usePathname();
  const current = active ?? activeSub(pathname);
  return (
    <nav aria-label="AI Gateway" className="sticky top-16 flex flex-col gap-0.5 pt-1 max-[900px]:static max-[900px]:flex-row max-[900px]:overflow-x-auto max-[900px]:border-b max-[900px]:border-line max-[900px]:pb-1">
      {AI_SUBS.map(({ key, label, href, icon: Icon }) => (
        <Link key={key} href={href} aria-current={key === current ? "page" : undefined} className={cn(link, key === current && "bg-nav-active font-medium text-nav-active-text hover:bg-nav-active hover:text-nav-active-text")}>
          <Icon size={16} aria-hidden />{label}
        </Link>
      ))}
      <div className="mx-1 my-1.5 h-px bg-line max-[900px]:hidden" />
      <Link href="/api-docs" className={link}><IconApi size={16} aria-hidden />API explorer</Link>
    </nav>
  );
}
