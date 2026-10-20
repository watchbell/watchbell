"use client";

import { Fragment, type ReactNode, useState } from "react";
import { Pager } from "@/components/pager";
import { type ListRow, TableHead, tableClass } from "@/components/table";
import { paginate, rangeText } from "@/lib/view/paginate";

// A table without a toolbar (Overview → Applications, app page tabs). It still pages at 25 rows; the pager is
// hidden while everything fits, and the 60 s refresh keeps the page (clamped if the rows shrink).
export function PlainTable({ head, rows }: { head: ReactNode[]; rows: ListRow[] }) {
  const [page, setPage] = useState(1);
  const paged = paginate(rows, page);
  // Rows shrank under the stored page: store the clamped page too, so growing back later does not jump to the old one.
  if (paged.page !== page) setPage(paged.page);
  return (
    <>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={head} />
          <tbody>{paged.rows.map((r) => <Fragment key={r.key}>{r.row}</Fragment>)}</tbody>
        </table>
      </div>
      <Pager page={paged.page} pages={paged.pages} text={rangeText(paged)} onPage={setPage} />
    </>
  );
}
