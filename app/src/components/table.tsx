import type { ReactNode } from "react";

// The mockup's table: grey header band, 9 px rows, 18 px first-column inset, no border under the last row.
export const th = "whitespace-nowrap border-y border-line bg-surface-2 px-3 py-2 text-left text-[12.5px] font-medium text-ink-soft first:pl-[18px] last:pr-3.5";
export const td = "whitespace-nowrap border-b border-line px-3 py-[9px] align-middle first:pl-[18px] last:pr-3.5";
export const tdWrap = "min-w-40 whitespace-normal";
export const rowClass = "hover:bg-hover";
export const tableClass = "w-full border-collapse [&_tbody_tr:last-child_td]:border-b-0";

// A row as the filter sees it: its state (for the select), its visible text (for the search box) and the <tr> itself.
export type ListRow = { key: string; state: string; text: string; group?: string; tags?: string[]; row: ReactNode };

export function TableHead({ head }: { head: ReactNode[] }) {
  return <thead><tr>{head.map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>;
}
