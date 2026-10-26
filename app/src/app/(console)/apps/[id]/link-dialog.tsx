"use client";

import { IconLink } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DbName, Masked, useMask } from "@/components/alias";
import { Button, buttonClass, Tag } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DB_PROVIDER_NAME, type DbOption, dbProvider, orderOptions } from "@/lib/links";
import { saveDatabaseLink } from "./link-actions";

// Mockup linkDlg: one radio per watched database (any provider), "Current" and "Suggested" tags, and "No database".
export function LinkDialog({ app, options, current, suggested }: { app: { id: string; name: string }; options: DbOption[]; current: string | null; suggested: string | null }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>(current ?? "");
  const [saving, start] = useTransition();
  const mask = useMask();
  useHoldRefresh(open);
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setPicked(current ?? suggested ?? "");
  }
  function save() {
    start(async () => {
      try {
        const r = await saveDatabaseLink(app.id, picked || null);
        if (!r.ok) { toast.error(r.error); return; }
        toast.success("Link saved", { description: r.message ? mask("text", r.message) : undefined });
        setOpen(false);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }
  return (
    // Esc and the scrim do nothing while the save runs.
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogTrigger className={buttonClass({ size: "sm", variant: "ghost" })}>Edit link</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconLink size={19} /></span>
          <div>
            <DialogTitle className="text-base">Database for <Masked kind="app" real={app.name} /></DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              Used by Topology, the app status (a paused database makes the app Degraded), and alerts. The console suggests one by name. It never reads your app&apos;s secrets.
            </DialogDescription>
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto px-[18px] pb-2">
          {[...orderOptions(app.name, options, suggested, current).map((o) => ({ id: o.id, name: o.name, sub: `${DB_PROVIDER_NAME[dbProvider(o.kind)]} · ${mask("account", o.account)}`, where: [o.region, o.ident].filter(Boolean).join(" · ") })), { id: "", name: "No database", sub: "This app doesn't use one", where: "" }].map((o) => (
            <label key={o.id || "none"} className="flex cursor-pointer items-center gap-3 border-b border-line px-1 py-[9px] last:border-b-0 hover:bg-hover">
              <input type="radio" name="link" className="size-4 accent-brand" checked={picked === o.id} onChange={() => setPicked(o.id)} />
              <span className="min-w-0 flex-1"><span className="block truncate">{o.id ? <DbName id={o.id} name={o.name} /> : o.name}</span><span className="block truncate text-[12px] text-ink-faint">{o.sub}</span>{o.where && <span className="block truncate font-mono text-[11.5px] text-ink-faint" title={o.where}>{o.where}</span>}</span>
              {o.id && o.id === current && <Tag>Current</Tag>}
              {o.id && o.id !== current && o.id === suggested && <span className="rounded bg-brand-soft px-1.5 py-px font-mono text-[10.5px] text-brand">Suggested</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save link"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
