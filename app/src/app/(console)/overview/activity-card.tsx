import Link from "next/link";
import { Masked, MaskedText } from "@/components/alias";
import { Card } from "@/components/kit";
import { StateIcon } from "@/components/status";
import type { DeploymentRow } from "@/lib/data/deployments-db";
import type { EventRow } from "@/lib/data/events-db";
import { cn } from "@/lib/utils";
import { deployDuration, eventTime, shortSha } from "@/lib/view/format";
import { STATE_WORD } from "@/lib/view/labels";

const item = "flex items-start gap-2.5 border-b border-line py-2 text-[13px] last:border-b-0";

// Mockup section 1 → Activity: "Ongoing" only while something builds, then the 5 most recent events.
export function ActivityCard({ builds, events, now }: { builds: DeploymentRow[]; events: EventRow[]; now: Date }) {
  return (
    <Card title="Activity" meta={<Link href="/events">View events</Link>}>
      {builds.length > 0 && (
        <>
          <div className="my-1.5 text-[12.5px] text-ink-faint">Ongoing</div>
          <div>
            {builds.map((b) => (
              <div key={b.id} className={item}>
                <StateIcon state="build" />
                <div className="flex-1">
                  <b className="font-medium">Building <Masked kind="app" real={b.appName} /></b>
                  <p className="mt-0.5 text-ink-soft">{b.branch ?? "—"} · {shortSha(b.commitSha)} · {deployDuration(b, now)}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className={cn("mb-1.5 text-[12.5px] text-ink-faint", builds.length > 0 ? "mt-3" : "mt-1.5")}>Recent events</div>
      {events.length === 0 ? <p className="py-2 text-[13px] text-ink-soft">No events yet</p> : (
        <div>
          {events.map((e) => (
            <div key={e.id} className={item}>
              <time className="min-w-10 whitespace-nowrap pt-px font-mono text-xs text-ink-faint" dateTime={(e.lastAt ?? e.at).toISOString()}>{eventTime(e.lastAt ?? e.at, now)}</time>
              <StateIcon state={e.kind} still />
              <div>
                <span className="sr-only">{STATE_WORD[e.kind]}: </span><MaskedText text={e.message} /> · <MaskedText text={e.resource} />
                {e.detail && <p className="mt-0.5 text-ink-soft"><MaskedText text={e.detail} /></p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
