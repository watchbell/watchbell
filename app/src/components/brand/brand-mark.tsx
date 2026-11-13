import { BellMark } from "./bell-mark";

// Watchbell 1.7 (spec §7): the brand's logo where the Watchbell bell stood (sign-in page, sidebar, status page).
export function BrandMark({ name, hasLogo, size = 28, className }: { name: string; hasLogo: boolean; size?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a small stored PNG, served by /brand-icon
  if (hasLogo) return <img src="/brand-icon" alt={name} width={size} height={size} className={className} style={{ borderRadius: 6 }} />;
  return <BellMark size={size} className={className} />;
}
