"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Banner, buttonClass } from "@/components/kit";
import { aiBanner } from "./ai-banner";

// Step 3: shown on every AI Gateway sub-page while no provider connection is enabled. The Bring your own key page is where
// the owner fixes it, so the banner steps aside there. `show` comes from the server layout (a DB read, not repeated here).
// `antigravityModels`: how many Antigravity models are on when the VM reported within 24 h (owner 13 Oct), else null;
// then the console's AI does work (over MCP), so the banner is informational with a quiet link instead of a button.
export function NoProviderBanner({ show, antigravityModels = null, provider = null }: { show: boolean; antigravityModels?: number | null; provider?: { name: string; model: string } | null }) {
  const pathname = usePathname();
  const b = aiBanner({ show, antigravityModels, pathname, provider });
  if (!b) return null;
  if (b.kind === "antigravity" || b.kind === "provider") {
    return (
      <Banner
        tone="info"
        title={b.title}
        action={<Link href={b.link.href} className="whitespace-nowrap text-[13px] text-ink-soft underline-offset-2 hover:underline">{b.link.text}</Link>}
      >
        {b.body}
      </Banner>
    );
  }
  return (
    <Banner tone="warning" title={b.title} action={<Link href={b.action.href} className={buttonClass({ size: "sm" })}>{b.action.text}</Link>}>
      {b.body}
    </Banner>
  );
}
