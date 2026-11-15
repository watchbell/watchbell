import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand/brand-mark";

// Watchbell 1.7 (spec §7): the sidebar header with the brand's name and logo (the bell and "Watchbell" without one).
// 1.8: under the name, the workspace switcher (children); the logo and the name link home, the switcher doesn't (a
// menu button can't sit inside a link). Rendered inside the client sidebar; it reads nothing itself.
export function ConsoleBrand({ name, hasLogo, logoVersion = null, children }: { name: string; hasLogo: boolean; logoVersion?: string | null; children?: ReactNode }) {
  return (
    <>
      <Link href="/" aria-label={`${name}, home`} className="shrink-0 hover:no-underline">
        <BrandMark name={name} hasLogo={hasLogo} logoVersion={logoVersion} />
      </Link>
      <span className="min-w-0 flex-1">
        <Link href="/" className="block truncate font-semibold text-ink hover:no-underline">{name}</Link>
        {children ?? <small className="block text-xs text-ink-faint">Personal</small>}
      </span>
    </>
  );
}
