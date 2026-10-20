import type { Severity } from "@/lib/security/types";
import { cn } from "@/lib/utils";
import { SEVERITY_LABEL } from "@/lib/view/security";

// The mockup's `.sev` tag: critical/high red, moderate amber, low/unknown blue. Text, never colour alone.
const TONE: Record<Severity, string> = {
  CRITICAL: "bg-err-soft text-err", HIGH: "bg-err-soft text-err", MODERATE: "bg-warn-soft text-warn",
  LOW: "bg-brand-soft text-brand", UNKNOWN: "bg-brand-soft text-brand",
};
const SEV = "inline-block whitespace-nowrap rounded-[5px] px-2 py-px text-xs font-medium";

export function SevTag({ severity }: { severity: Severity }) {
  return <span className={cn(SEV, TONE[severity])}>{SEVERITY_LABEL[severity]}</span>;
}

// Applications list: the small "CVE" tag next to a vulnerable app's name. The title carries the details.
export function CveTag({ tag }: { tag: { label: string; severe: boolean; title: string } }) {
  return (
    <span title={tag.title} className={cn(SEV, "ml-1.5", tag.severe ? TONE.CRITICAL : TONE.MODERATE)}>
      {tag.label}<span className="sr-only">: {tag.title}</span>
    </span>
  );
}

// The Alerts page's severity tag (the mockup's `.sev.critical|warning|info`): same look as the security card's.
const ALERT_TONE = { critical: TONE.CRITICAL, warning: TONE.MODERATE, info: TONE.LOW } as const;

export function AlertSev({ severity }: { severity: keyof typeof ALERT_TONE }) {
  return <span className={cn(SEV, ALERT_TONE[severity])}>{severity[0].toUpperCase() + severity.slice(1)}</span>;
}
