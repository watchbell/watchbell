import { IconUser } from "@tabler/icons-react";
import Link from "next/link";
import { DbName, Masked, type MaskKind } from "@/components/alias";
import { cn } from "@/lib/utils";

const KINDS = {
  app: ["APP", "bg-brand-soft text-brand"],
  db: ["DB", "bg-teal-soft text-teal"],
  br: ["BR", "bg-teal-soft text-teal"],
  fs: ["FS", "bg-teal-soft text-teal"],
  mon: ["MON", "bg-amber-soft text-amber"],
  dpl: ["DPL", "bg-gray-soft text-ink-soft"],
  dom: ["DOM", "bg-gray-soft text-ink-soft"],
  dns: ["DNS", "bg-gray-soft text-ink-soft"],
  usr: ["USR", "bg-gray-soft text-ink-soft"],
} as const;
export type ResourceKind = keyof typeof KINDS;

export function ResourceBadge({ kind }: { kind: ResourceKind }) {
  const [label, tone] = KINDS[kind];
  return <span className={cn("rounded px-[5px] py-px font-mono text-[10.5px] font-medium tracking-[0.02em]", tone)}>{label}</span>;
}

// Privacy (lib/view/display-name.ts): a database (`dbId`) shows its alias with click to reveal, so it never sits inside
// a link (the caller links the provider instead); any other name shows without emails. A member (usr) is shown as is:
// Settings lists members by their address on purpose. In screenshot mode an app becomes app-a, a member's address
// "[email hidden]", and any other name (a domain, a monitor) has its hosts and names masked; the link keeps its target.
const MASK: Partial<Record<ResourceKind, MaskKind>> = { app: "app", usr: "email" };

export function Resource({ kind, name, href, dbId }: { kind: ResourceKind; name: string; href?: string; dbId?: string }) {
  const mask = MASK[kind] ?? "text";
  return (
    <span className="inline-flex items-center gap-[7px]">
      <ResourceBadge kind={kind} />
      {dbId ? <DbName id={dbId} name={name} /> : href ? <Link href={href}><Masked kind={mask} real={name} inLink /></Link> : <span><Masked kind={mask} real={name} /></span>}
    </span>
  );
}

export function AccountChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] border border-line bg-sunken px-1.5 text-xs text-ink-soft">
      <IconUser size={13} aria-hidden />
      <Masked kind="account" real={name} />
    </span>
  );
}
