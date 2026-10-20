"use client";

import { IconFilterOff, IconX } from "@tabler/icons-react";
import { Fragment, type ReactNode, useState } from "react";
import { Masked, useMask } from "@/components/alias";
import { EmptyState, fieldClass } from "@/components/kit";
import { Pager } from "@/components/pager";
import { type ListRow, TableHead, tableClass } from "@/components/table";
import { cn } from "@/lib/utils";
import { filterRows } from "@/lib/view/filter";
import { itemCount } from "@/lib/view/format";
import { paginate, rangeText } from "@/lib/view/paginate";

// The mockup's toolbar() + table(): a text filter over the whole row, a state select with a removable chip, a live
// count, and "No results" with "Clear filters". The filter state is client state, so the 60 s refresh keeps it.
// With no rows at all there is nothing to filter: callers render the typed empty state (NoApps, NoMonitors, ...)
// instead of this component, and it stays silent about "No results" if they do not.
// `groups` adds an account select (Databases pages) with its own chip.
// Paging (25 a page) comes after filtering. Any change to the filters goes back to page 1, but the 60 s refresh does
// not: the page is client state too, and paginate() clamps it when the rows shrink.
export function ListFilter({ placeholder, states, groups, head, rows, chips }: { placeholder: string; states?: [string, string][]; groups?: string[]; head: ReactNode[]; rows: ListRow[]; chips?: [string, string][] }) {
  const [text, setText] = useState("");
  const [state, setState] = useState("");
  const [tag, setTag] = useState("");
  const [group, setGroup] = useState("");
  const [page, setPage] = useState(1);
  const mask = useMask();
  // The search box finds a row by what it shows and by the real names behind it: in screenshot mode the masked text
  // (app-a, site-a.example) is searched too (privacy).
  const searchable = rows.map((r) => ({ ...r, text: `${r.text} ${mask("text", r.text)}` }));
  const filtered = filterRows(searchable, { text, state, group, tag });
  const paged = paginate(filtered, page);
  const shown = paged.rows;
  // Rows shrank under the stored page: store the clamped page too, so growing back later does not jump to the old one.
  if (paged.page !== page) setPage(paged.page);
  const stateLabel = states?.find(([v]) => v === state)?.[1];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pt-3.5 max-[720px]:px-3.5">
        <input className={cn(fieldClass, "w-[240px] max-[720px]:w-full")} placeholder={placeholder} aria-label={placeholder} value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} />
        {states && (
          <select className={cn(fieldClass, "w-auto")} aria-label="State" value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}>
            <option value="">All states</option>
            {states.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {groups && groups.length > 1 && (
          <select className={cn(fieldClass, "w-auto")} aria-label="Account" value={group} onChange={(e) => { setGroup(e.target.value); setPage(1); }}>
            <option value="">All accounts</option>
            {groups.map((g) => <option key={g} value={g}>{mask("account", g)}</option>)}
          </select>
        )}
        {chips?.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={tag === v} onClick={() => { setTag(tag === v ? "" : v); setPage(1); }}
            className={cn("rounded-[5px] border px-2 py-0.5 text-[12.5px]", tag === v ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft hover:bg-hover")}>
            {l}
          </button>
        ))}
        {stateLabel && (
          <span className="inline-flex items-center gap-1 rounded-[5px] bg-brand-soft py-px pl-2 pr-1 text-[12.5px] text-brand">
            State: {stateLabel}
            <button type="button" aria-label="Remove filter" className="px-0.5" onClick={() => { setState(""); setPage(1); }}><IconX size={13} /></button>
          </span>
        )}
        {group && (
          <span className="inline-flex items-center gap-1 rounded-[5px] bg-brand-soft py-px pl-2 pr-1 text-[12.5px] text-brand">
            Account: <Masked kind="account" real={group} />
            <button type="button" aria-label="Remove account filter" className="px-0.5" onClick={() => { setGroup(""); setPage(1); }}><IconX size={13} /></button>
          </span>
        )}
        <span role="status" className="ml-auto text-[12.5px] text-ink-soft">{itemCount(filtered.length)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={head} />
          <tbody>{shown.map((r) => <Fragment key={r.key}>{r.row}</Fragment>)}</tbody>
        </table>
      </div>
      {filtered.length === 0 && rows.length > 0 && (
        <EmptyState icon={IconFilterOff} title="No results">
          Nothing matches these filters.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => { setText(""); setState(""); setGroup(""); setTag(""); setPage(1); }}>Clear filters</button>
        </EmptyState>
      )}
      <Pager page={paged.page} pages={paged.pages} text={rangeText(paged)} onPage={setPage} />
    </>
  );
}
