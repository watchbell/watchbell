import { BrandMark } from "@/components/brand/brand-mark";

// Watchbell 1.7 (spec §7): the sidebar header with the brand's name and logo (the bell and "Watchbell" without one).
// Rendered inside the client sidebar; it reads nothing itself.
export function ConsoleBrand({ name, hasLogo, logoVersion = null }: { name: string; hasLogo: boolean; logoVersion?: string | null }) {
  return (
    <>
      <BrandMark name={name} hasLogo={hasLogo} logoVersion={logoVersion} />
      <span className="min-w-0">
        <b className="block truncate font-semibold">{name}</b>
        <small className="block text-xs text-ink-faint">Personal</small>
      </span>
    </>
  );
}
