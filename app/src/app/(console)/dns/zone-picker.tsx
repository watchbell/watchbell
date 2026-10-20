"use client";

import { useRouter } from "next/navigation";
import { useMask } from "@/components/alias";
import { fieldClass } from "@/components/kit";
import { cn } from "@/lib/utils";

// DNS records → zone select. The zone is a search parameter, so the page stays a Server Component.
export function ZonePicker({ zones, current }: { zones: { id: string; name: string }[]; current: string }) {
  const router = useRouter();
  const mask = useMask();
  return (
    <select aria-label="Zone" className={cn(fieldClass, "w-auto")} value={current} onChange={(e) => router.push(`/dns?zone=${e.target.value}`)}>
      {zones.map((z) => <option key={z.id} value={z.id}>{mask("text", z.name)}</option>)}
    </select>
  );
}
