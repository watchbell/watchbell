"use client";

import { IconBrandGithub, IconRefresh } from "@tabler/icons-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Masked, useMask } from "@/components/alias";
import { Button, buttonClass, fieldClass, Tag } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { RepoOption } from "@/lib/data/github-db";
import { cn } from "@/lib/utils";
import { linkRepo, refreshRepoActions } from "./github-actions";

// B7: like the database's "Edit link": one radio per repository the GitHub token sees, the suggestion pre-picked,
// and "No repository". Owner only; the owner's choice is never overwritten by a sync.
export function RepoDialog({ app, options, current, suggested, label }: {
  app: { id: string; name: string }; options: RepoOption[]; current: string | null; suggested: string | null; label: string;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(current ?? "");
  const [query, setQuery] = useState("");
  const [saving, start] = useTransition();
  const mask = useMask();
  useHoldRefresh(open);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = options.filter((o) => !q || o.fullName.toLowerCase().includes(q) || mask("repo", o.fullName).toLowerCase().includes(q));
    const first = [current, suggested].filter((x): x is string => !!x);
    return [...list.filter((o) => first.includes(o.id)), ...list.filter((o) => !first.includes(o.id))].slice(0, 100);
  }, [options, query, current, suggested, mask]);
  function save() {
    start(async () => {
      try {
        const r = await linkRepo(app.id, picked || null);
        if (!r.ok) { toast.error(r.error); return; }
        toast.success("Link saved", { description: r.message ? mask("text", r.message) : undefined });
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (saving) return; setOpen(next); if (next) { setPicked(current ?? suggested ?? ""); setQuery(""); } }}>
      <DialogTrigger className={buttonClass({ size: "sm", variant: "ghost" })}>{label}</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconBrandGithub size={19} /></span>
          <div>
            <DialogTitle className="text-base">Repository for <Masked kind="app" real={app.name} /></DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              Shows the repository and its GitHub Actions status on this page. The console reads it with the read-only token and never writes to it.
            </DialogDescription>
          </div>
        </div>
        <div className="px-[18px] pb-2">
          <input className={cn(fieldClass, "w-full")} placeholder="Filter repositories" aria-label="Filter repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="max-h-[320px] overflow-y-auto px-[18px] pb-2">
          {[...shown.map((o) => ({ id: o.id, name: o.fullName, archived: o.archived })), { id: "", name: "No repository", archived: false }].map((o) => (
            <label key={o.id || "none"} className="flex cursor-pointer items-center gap-3 border-b border-line px-1 py-[9px] last:border-b-0 hover:bg-hover">
              <input type="radio" name="repo" className="size-4 accent-brand" checked={picked === o.id} onChange={() => setPicked(o.id)} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{o.id ? <Masked kind="repo" real={o.name} /> : <span className="font-sans text-[13.5px]">{o.name}</span>}</span>
              {o.archived && <Tag>Archived</Tag>}
              {o.id && o.id === current && <Tag>Current</Tag>}
              {o.id && o.id !== current && o.id === suggested && <span className="rounded bg-brand-soft px-1.5 py-px font-mono text-[10.5px] text-brand">Suggested</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" disabled={saving || picked === (current ?? "")} onClick={save}>{saving ? "Saving…" : "Save link"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The suggestion in one click: "Link to owner/repo" (owner).
export function ConfirmRepo({ appId, repoId, fullName }: { appId: string; repoId: string; fullName: string }) {
  const [pending, start] = useTransition();
  const mask = useMask();
  return (
    <Button size="sm" variant="primary" disabled={pending} onClick={() => start(async () => {
      const r = await linkRepo(appId, repoId);
      if (r.ok) toast.success(r.message ? mask("text", r.message) : "Linked.");
      else toast.error(r.error);
    })}>
      {pending ? "Linking…" : <>Link to <Masked kind="repo" real={fullName} /></>}
    </Button>
  );
}

export function RefreshActionsButton({ appId }: { appId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => start(async () => {
      const r = await refreshRepoActions(appId);
      if (r.ok) toast.success(r.message ?? "Refreshed.");
      else toast.error(r.error);
    })}>
      <IconRefresh size={14} aria-hidden />{pending ? "Reading…" : "Refresh"}
    </Button>
  );
}
