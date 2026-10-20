"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { DbName, Masked, useMask } from "@/components/alias";
import { Banner, Button, buttonClass, EmptyState } from "@/components/kit";
import { ResourceBadge } from "@/components/resource";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { SyncKind } from "@/lib/sync";
import type { SyncRow } from "@/lib/sync-db";
import { saveSyncSelection, syncNow } from "./sync-actions";

type Loaded = { rows: SyncRow[]; skippedTeams: string[]; overLimit: string | null };

// The dialog's wording per kind of resource the account's Sync lists; each row's badge comes from the row itself.
const COPY: Record<SyncKind, { what: string; looking: string; none: string }> = {
  app: { what: "projects", looking: "Looking for projects in every team this token can read…", none: "This Vercel account has no projects yet." },
  zone: { what: "zones", looking: "Looking for zones in this Cloudflare account…", none: "This Cloudflare account has no zones yet." },
  supabase_project: { what: "projects", looking: "Looking for projects this credential can read…", none: "This account has no projects yet." },
  neon_project: { what: "projects", looking: "Looking for projects this credential can read…", none: "This account has no projects yet." },
  firestore: { what: "projects", looking: "Looking for projects this credential can read…", none: "This account has no projects yet." },
  turso_database: { what: "databases", looking: "Looking for databases in the organizations this token can read…", none: "This Turso account has no databases yet." },
  upstash_redis: { what: "databases", looking: "Looking for Redis databases this key can read…", none: "This Upstash account has no Redis databases yet." },
};

export function SyncButton({ accountId, title, label = "Sync", primary, watchNew: savedWatchNew, kind = "app" }: { accountId: string; title: string; label?: string; primary?: boolean; watchNew: boolean; kind?: SyncKind }) {
  const copy = COPY[kind];
  const mask = useMask();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [watchNew, setWatchNew] = useState(savedWatchNew);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setLoaded(null);
    setError(null);
    setPicked(new Set());
    setWatchNew(savedWatchNew);
    startLoad(async () => {
      const r = await syncNow(accountId);
      if (!r.ok || !r.data) {
        setError(r.ok ? "Sync returned nothing." : r.error);
        return;
      }
      setLoaded(r.data);
      setPicked(new Set(r.data.rows.filter((x) => x.monitored).map((x) => x.id)));
    });
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    startSave(async () => {
      const r = await saveSyncSelection(accountId, [...picked], watchNew);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const description = `Watching ${picked.size} of ${loaded?.rows.length ?? 0} resources in ${mask("text", title)}. Checks start on the next collector run.`;
      const over = r.data?.overLimit;
      if (over) toast.warning("Selection saved", { description: `${description} ${over}` });
      else toast.success("Selection saved", { description });
      setOpen(false);
    });
  }

  const rows = useMemo(() => loaded?.rows ?? [], [loaded]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger className={buttonClass({ size: "sm", variant: primary ? "primary" : "secondary" })}>
        <IconRefresh size={15} aria-hidden /> {label}
      </DialogTrigger>
      <DialogContent className="max-w-[640px] gap-0 p-0 sm:max-w-[640px]" aria-label="Sync resources">
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconRefresh size={19} /></span>
          <div>
            <DialogTitle className="text-base">Sync {mask("text", title)}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              {loaded
                ? `Found ${rows.length} resources just now. Pick the ones the console should watch. Unticked ones are ignored and cost nothing.`
                : error ? `The list of ${copy.what} could not be loaded.` : copy.looking}
            </DialogDescription>
          </div>
        </div>
        <div className="px-[18px] pb-2">
          {error && <div className="mb-2"><Banner tone="danger" title="Sync didn't finish">{error}</Banner></div>}
          {loaded && loaded.skippedTeams.length > 0 && (
            <div className="mb-2"><Banner tone="info" title="Some teams were skipped">This token can&apos;t read {loaded.skippedTeams.join(", ")}. Create a token with access to them to include their projects.</Banner></div>
          )}
          {loaded?.overLimit && <div className="mb-2"><Banner tone="warning" title="Monitor limit reached">{loaded.overLimit}</Banner></div>}
          {loading && <p className="py-6 text-center text-[13px] text-ink-soft">Syncing…</p>}
          {loaded && rows.length === 0 && <EmptyState title="Nothing found">{copy.none}</EmptyState>}
          {loaded && rows.length > 0 && (
            <>
              <div className="mb-1.5 flex gap-1.5">
                <Button size="sm" onClick={() => setPicked(new Set(rows.map((x) => x.id)))}>Select all</Button>
                <Button size="sm" onClick={() => setPicked(new Set())}>Select none</Button>
              </div>
              <div className="max-h-[360px] overflow-y-auto rounded-md border border-line">
                {rows.map((x) => (
                  <label key={x.id} className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-[9px] last:border-b-0 hover:bg-hover">
                    <input type="checkbox" className="size-4 accent-brand" checked={picked.has(x.id)} onChange={() => toggle(x.id)} />
                    <ResourceBadge kind={x.badge} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{x.badge === "db" || x.badge === "fs" ? <DbName id={x.id} name={x.name} alias={x.alias} /> : <Masked kind={x.badge === "app" ? "app" : "text"} real={x.name} />}</span>
                      <span className="block truncate text-[12px] text-ink-faint"><Masked kind="text" real={x.sub} /></span>
                    </span>
                    {x.fresh && <span className="rounded bg-brand-soft px-1.5 py-px font-mono text-[10.5px] text-brand">New</span>}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-3">
          <span className="text-[12.5px] text-ink-soft">{picked.size} of {rows.length} selected</span>
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" className="size-4 accent-brand" checked={watchNew} onChange={(e) => setWatchNew(e.target.checked)} />
            Watch new ones automatically
          </label>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!loaded || saving} onClick={save}>{saving ? "Saving…" : "Save selection"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
