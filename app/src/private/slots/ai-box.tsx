import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The mockup's .ai-note: icon, content, one-line meta, on a surface with a coloured left rule. Plain markup, so it
// renders on the server and inside client components alike.
const RULE = { brand: "border-l-brand", err: "border-l-err", warn: "border-l-warn-icon" } as const;

export function AiBox({ icon, tone = "brand", meta, action, className, children }: {
  icon: ReactNode; tone?: keyof typeof RULE; meta?: ReactNode; action?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <div className={cn("flex gap-2.5 rounded-md border border-line border-l-[3px] bg-surface-2 px-3 py-2.5 text-[13px]", RULE[tone], className)}>
      <span className="mt-px shrink-0 text-brand">{icon}</span>
      <div className="min-w-0 flex-1">
        {children}
        {meta && <span className="mt-1 block text-[12px] text-ink-faint">{meta}</span>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
