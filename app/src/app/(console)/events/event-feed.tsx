"use client";

import { IconFilterOff } from "@tabler/icons-react";
import { useState } from "react";
import { MaskedText, useMask } from "@/components/alias";
import { NoEvents } from "@/components/empty-states";
import { EmptyState, fieldClass, Tag } from "@/components/kit";
import { Pager } from "@/components/pager";
import { StateIcon } from "@/components/status";
import type { State } from "@/lib/status";
import { cn } from "@/lib/utils";
import { freshIds } from "@/lib/view/fresh";
import { EVENT_TYPES, STATE_WORD } from "@/lib/view/labels";
import { heldAnchor, paginateHeld, rangeText } from "@/lib/view/paginate";

export type FeedEvent = { id: string; iso: string; time: string; kind: State; type: string; typeLabel: string; resource: string; message: string; detail: string | null; repeat: string | null; reason: string | null };

// The page refreshes every 60 s (R1). "Show new events" off freezes the list as it was; rows that weren't there when
// the page opened flash once as they appear (onAnimationEnd marks a row done, so filtering it out and back doesn't repeat it). The type and resource filters are client state, so a refresh keeps them (a row that a repeat moved to the top doesn't flash again: the flash goes by id).
// Pages of 25. New events show (and flash) at the top of page 1; from page 2 on, the rows stay where they are
// (the anchor holds the place, see paginateHeld) while the range and total count the new events. The type filter goes back to page 1.
export function EventFeed({ events }: { events: FeedEvent[] }) {
  const [type, setType] = useState("");
  const [res, setRes] = useState("");
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const [seen] = useState(() => new Set(events.map((e) => e.id)));
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [anchor, setAnchor] = useState<string | null>(null);
  const mask = useMask();
  const shown = frozen ?? events;
  if (shown.length === 0) return <NoEvents />;
  const resources = [...new Set(events.map((e) => e.resource))].sort((a, b) => a.localeCompare(b));
  const list = shown.filter((e) => (!type || e.type === type) && (!res || e.resource === res));
  const paged = paginateHeld(list, page, anchor);
  const fresh = freshIds(seen, flashed, paged.rows);
  // Clamped (rows shrank) or fallen back to the true first page: store that, so Next never goes dead.
  if (paged.page !== page) { setPage(paged.page); if (paged.page <= 1) setAnchor(null); }
  const go = (to: number) => { setPage(to); setAnchor(heldAnchor(list, paged.shift, anchor, to)); };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pb-1.5 pt-0.5">
        <select className={cn(fieldClass, "w-auto")} aria-label="Event type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); setAnchor(null); }}>
          <option value="">All types</option>
          {EVENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className={cn(fieldClass, "w-auto")} aria-label="Resource" value={res} onChange={(e) => { setRes(e.target.value); setPage(1); setAnchor(null); }}>
          <option value="">All resources</option>
          {resources.map((r) => <option key={r} value={r}>{mask("text", r)}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" className="size-4 accent-brand" checked={frozen === null} onChange={(e) => setFrozen(e.target.checked ? null : events)} />
          Show new events
        </label>
        <span className="ml-auto text-[12.5px] text-ink-soft">Polling every 60s</span>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={IconFilterOff} title="No results">
          Nothing matches these filters.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => { setType(""); setRes(""); setPage(1); setAnchor(null); }}>Clear filters</button>
        </EmptyState>
      ) : (
        <div>
          {paged.rows.map((e) => (
            <div key={e.id} className={cn("flex items-start gap-2.5 border-b border-line py-2 text-[13px] last:border-b-0", fresh.has(e.id) && "animate-[oc-flash_1.4s_ease-out] motion-reduce:animate-none")}
              onAnimationEnd={() => setFlashed((f) => new Set(f).add(e.id))}>
              <time className="min-w-10 whitespace-nowrap pt-px font-mono text-xs text-ink-faint" dateTime={e.iso}>{e.time}</time>
              <StateIcon state={e.kind} still />
              <div className="flex-1">
                <span className="sr-only">{STATE_WORD[e.kind]}: </span>
                <Tag>{e.typeLabel}</Tag><b className="font-medium"><MaskedText text={e.resource} /></b> · <MaskedText text={e.message} />
                {e.repeat && <span className="ml-1.5 rounded border border-line bg-sunken px-[5px] font-mono text-[11px] text-ink-soft" title="Same change repeated within an hour">{e.repeat}</span>}
                {e.detail && <p className="mt-0.5 text-ink-soft"><MaskedText text={e.detail} /></p>}
              </div>
              {e.reason && <span className="font-mono text-[11.5px] text-ink-faint">{e.reason}</span>}
            </div>
          ))}
        </div>
      )}
      <Pager page={paged.page} pages={paged.pages} text={rangeText(paged, paged.shift, list.length)} onPage={go} bleed />
    </>
  );
}
