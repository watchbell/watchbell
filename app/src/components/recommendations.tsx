import { IconCircleCheck } from "@tabler/icons-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { MaskedText } from "@/components/alias";
import { buttonClass, Card, EmptyState } from "@/components/kit";
import { Src } from "@/components/sources";
import { StateIcon } from "@/components/status";
import type { Rec } from "@/lib/advisor/rules";
import { DismissButton } from "./dismiss-button";

// Mockup recCard(): the Advisor's daily hygiene items, on Overview (all, with the app named) and on an app's Details tab
// (its own, hidden when there are none). Rows look like the Activity card's. "How to fix" is a link, so every role
// sees it; Dismiss needs an Operator.
// 5c slots (owner only, rendered by the page from @/lib/extensions): `summary` above the list (Overview only) and
// `notes` (AI notes from agents). A card with notes is never hidden for being empty.
export function Recommendations({ items, canDismiss, showSubject, hideWhenEmpty = false, max, summary = null, notes = null }: {
  items: Rec[]; canDismiss: boolean; showSubject: boolean; hideWhenEmpty?: boolean; max?: number; summary?: ReactNode; notes?: ReactNode;
}) {
  if (hideWhenEmpty && items.length === 0 && !notes) return null;
  const shown = max === undefined ? items : items.slice(0, max);
  return (
    <Card title={`Recommendations (${items.length})`} meta={<>Daily at 03:00<Src kind="calc" /></>}>
      {summary}
      {notes}
      {items.length === 0 ? (
        <EmptyState icon={IconCircleCheck} title="Nothing to tidy up">The daily check found no hygiene items.</EmptyState>
      ) : (
        <div>
          {shown.map((r) => (
            <div key={r.key} className="flex items-start gap-2.5 border-b border-line py-2 text-[13px] last:border-b-0">
              <StateIcon state={r.severity === "warning" ? "warn" : "info"} />
              <div className="min-w-0 flex-1">
                <span className="sr-only">{r.severity === "warning" ? "Warning" : "Info"}: </span>
                <b className="font-medium"><MaskedText text={r.title} /></b>
                {showSubject && <span className="text-ink-faint"> · <MaskedText text={r.subject} /></span>}
                <p className="mt-0.5 text-ink-soft"><MaskedText text={`${r.why} ${r.fix}`} /></p>
              </div>
              <span className="flex shrink-0 gap-1.5">
                {/^https?:\/\//.test(r.href)
                  ? <a href={r.href} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: "ghost", size: "sm" })}>How to fix</a>
                  : <Link href={r.href} className={buttonClass({ variant: "ghost", size: "sm" })}>How to fix</Link>}
                {canDismiss && <DismissButton recKey={r.key} />}
              </span>
            </div>
          ))}
          {shown.length < items.length && <p className="pt-2 text-[12.5px] text-ink-faint">+{items.length - shown.length} more</p>}
        </div>
      )}
    </Card>
  );
}
