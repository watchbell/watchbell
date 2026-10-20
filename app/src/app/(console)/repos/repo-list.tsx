"use client";

import { IconFilterOff } from "@tabler/icons-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Masked } from "@/components/alias";
import { EmptyState, fieldClass } from "@/components/kit";
import { Pager } from "@/components/pager";
import { ResourceBadge } from "@/components/resource";
import { Status } from "@/components/status";
import { rowClass, TableHead, tableClass, td } from "@/components/table";
import { filterRepos, NO_FILTER, type RepoFilter, type RepoListItem } from "@/lib/github/browse";
import type { State } from "@/lib/status";
import { ago } from "@/lib/time";
import { itemCount } from "@/lib/view/format";
import { paginate, rangeText } from "@/lib/view/paginate";
import { cn } from "@/lib/utils";

// GitHub → Repositories: the synced repositories with a name search, linked/unlinked and private/public selects, newest
// push first. A row opens the repository; an app chip opens the app. Filters and the page are client state, so the
// list keeps them while it is open.

const HEAD = ["Repository", "Apps", "Branch", "Last push", "Language", "Advisories", "Actions"];
const mono = "font-mono text-[12.5px]";

export function VisibilityTag({ isPrivate, archived }: { isPrivate: boolean; archived?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <span className={cn("rounded-[5px] border px-1.5 text-xs", isPrivate ? "border-line bg-sunken text-ink-soft" : "border-brand/30 bg-brand-soft text-brand")}>{isPrivate ? "private" : "public"}</span>
      {archived && <span className="rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-faint">archived</span>}
    </span>
  );
}

export function RepoList({ items, nowMs }: { items: RepoListItem[]; nowMs: number }) {
  const router = useRouter();
  const [f, setF] = useState<RepoFilter>(NO_FILTER);
  const [page, setPage] = useState(1);
  const now = new Date(nowMs);
  const filtered = filterRepos(items, f);
  const paged = paginate(filtered, page);
  if (paged.page !== page) setPage(paged.page);
  const set = (patch: Partial<RepoFilter>) => { setF({ ...f, ...patch }); setPage(1); };
  const open = (id: string) => router.push(`/repos/${id}`);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pt-3.5 max-[720px]:px-3.5">
        <input className={cn(fieldClass, "w-[240px] max-[720px]:w-full")} placeholder="Filter by name" aria-label="Filter by name" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <select className={cn(fieldClass, "w-auto")} aria-label="Linked to an app" value={f.linked} onChange={(e) => set({ linked: e.target.value as RepoFilter["linked"] })}>
          <option value="">Linked and unlinked</option>
          <option value="linked">Linked to an app</option>
          <option value="unlinked">Not linked</option>
        </select>
        <select className={cn(fieldClass, "w-auto")} aria-label="Visibility" value={f.visibility} onChange={(e) => set({ visibility: e.target.value as RepoFilter["visibility"] })}>
          <option value="">Private and public</option>
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select>
        <span role="status" className="ml-auto text-[12.5px] text-ink-soft">{itemCount(filtered.length)} · newest push first</span>
      </div>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={HEAD} />
          <tbody>
            {paged.rows.map((r) => (
              <tr key={r.id} className={cn(rowClass, "cursor-pointer")} onClick={() => open(r.id)}>
                <td className={td}>
                  <span className="inline-flex items-center gap-2">
                    <Link href={`/repos/${r.id}`} className={mono} onClick={(e) => e.stopPropagation()}><Masked kind="repo" real={r.fullName} inLink /></Link>
                    <VisibilityTag isPrivate={r.private} archived={r.archived} />
                  </span>
                </td>
                <td className={td}>
                  {r.apps.length ? (
                    <span className="flex flex-wrap gap-1">
                      {r.apps.map((a) => (
                        <Link key={a.id} href={`/apps/${a.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-[5px] border border-line px-1.5 py-px text-xs hover:bg-hover">
                          <ResourceBadge kind="app" /><Masked kind="app" real={a.name} inLink />
                        </Link>
                      ))}
                    </span>
                  ) : <span className="text-ink-faint">—</span>}
                </td>
                <td className={cn(td, mono)}>{r.defaultBranch ?? "—"}</td>
                <td className={td}>{r.pushedAt ? ago(new Date(r.pushedAt), now) : <span className="text-ink-faint">never</span>}</td>
                <td className={cn(td, !r.language && "text-ink-faint")}>{r.language ?? "—"}</td>
                <td className={td}>
                  {r.advisories === null ? <span className="text-ink-faint" title="Not scanned">—</span>
                    : r.advisories === 0 ? <Status state="ok">None</Status>
                      : <Status state="warn"><span className={mono}>{r.advisories}</span> open</Status>}
                </td>
                <td className={td}>{r.actions ? <Status state={r.actions.state as State}>{r.actions.label}</Status> : <span className="text-ink-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && items.length > 0 && (
        <EmptyState icon={IconFilterOff} title="No results">
          Nothing matches these filters.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => { setF(NO_FILTER); setPage(1); }}>Clear filters</button>
        </EmptyState>
      )}
      <Pager page={paged.page} pages={paged.pages} text={rangeText(paged)} onPage={setPage} />
    </>
  );
}
