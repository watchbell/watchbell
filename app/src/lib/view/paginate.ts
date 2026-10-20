export const PAGE_SIZE = 25;

export type Paged<T> = { rows: T[]; page: number; pages: number; from: number; to: number; total: number };

// Client-side paging over rows that are already bounded. `page` is 1-based and clamped into 1..pages, so a refresh
// that shrinks the list never leaves the reader on a page that no longer exists. `from`/`to` are 1-based row
// numbers for "26–50 of 104" (0 and 0 when there are no rows).
export function paginate<T>(rows: readonly T[], page: number, size: number = PAGE_SIZE): Paged<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(wanted, 1), pages);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: current, pages, from: total === 0 ? 0 : start + 1, to: start + slice.length, total };
}

// "1–25 of 104" (en dash, plain digits). `shift` and `total` let the Events feed report true positions while it keeps
// a later page steady as new events arrive on top.
export function rangeText(p: Pick<Paged<unknown>, "from" | "to" | "total">, shift = 0, total = p.total): string {
  return `${p.from + shift}–${p.to + shift} of ${total}`;
}

// The Events feed is newest-first and new rows arrive on top. On page 1 that is what the reader wants. From page 2
// on it would push every row down a place, so the reader's place is held: `anchorId` is the row that was at the
// head when they left page 1, and everything above it is "newer", skipped while paging. `shift` is that count: add
// it to from/to (and use the full length as the total, see rangeText) to report true positions. Back on page 1, or
// when the anchor is gone, or when the held list shrinks to a single page, there is no shift.
export function paginateHeld<T extends { id: string }>(rows: readonly T[], page: number, anchorId: string | null, size: number = PAGE_SIZE): Paged<T> & { shift: number } {
  const held = anchorId === null ? 0 : Math.max(0, rows.findIndex((r) => r.id === anchorId));
  const held1 = paginate(rows.slice(held), page, size);
  if (held === 0 || held1.page > 1) return { ...held1, shift: held };
  return { ...paginate(rows, 1, size), shift: 0 };
}

// The anchor to store when the reader moves to page `to` of a held feed. Back to page 1 holds nothing. Otherwise keep
// the stored anchor only while it still shifts the list (`shift > 0`); when paginateHeld fell back to the true first
// page (anchor gone or the held list shrank) the old anchor is stale, so take the current head and Next keeps working.
export function heldAnchor(rows: readonly { id: string }[], shift: number, anchorId: string | null, to: number): string | null {
  if (to <= 1) return null;
  return shift > 0 && anchorId !== null ? anchorId : rows[0]?.id ?? null;
}
