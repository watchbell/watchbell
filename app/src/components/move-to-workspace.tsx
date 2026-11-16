"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { moveToWorkspace } from "@/app/(console)/workspaces/actions";
import { Button, fieldClass } from "@/components/kit";
import { Moving } from "@/components/moving";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// Watchbell 1.8 (spec §5, Moving): pick some of the page's things and the workspace they belong to. All their history
// goes with them; a domain or monitor moves its app (the hint says so). Shown only when there is somewhere to move to.
type Item = { id: string; name: string; hint?: string };
type Ws = { id: string; name: string };

export const moveTargets = (workspaces: Ws[], current: string | null): Ws[] => workspaces.filter((w) => w.id !== current);

export function MoveToWorkspace({ kind, items, workspaces, current }: { kind: "resource" | "repo"; items: Item[]; workspaces: Ws[]; current: string | null }) {
  const [open, setOpen] = useState(false);
  const targets = moveTargets(workspaces, current);
  if (workspaces.length < 2 || !items.length || !targets.length) return null;
  return (
    <div className="mb-3 flex justify-end">
      <Button onClick={() => setOpen(true)}>Move to workspace…</Button>
      {open && <MoveDialog kind={kind} items={items} targets={targets} onClose={() => setOpen(false)} />}
    </div>
  );
}

function MoveDialog({ kind, items, targets, onClose }: { kind: "resource" | "repo"; items: Item[]; targets: Ws[]; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [pending, start] = useTransition();
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const move = () => start(async () => {
    const r = await moveToWorkspace(kind, [...picked], to);
    if (r.ok) {
      toast.success(r.message ?? "Moved.");
      onClose();
    } else toast.error(r.error);
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogTitle className="text-base">Move to workspace</DialogTitle>
        <DialogDescription>Uptime, alerts, deployments and events go with them.</DialogDescription>
        <div className="flex flex-col gap-1 text-[13px]">
          {items.map((i) => (
            <label key={i.id} className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-brand" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="font-medium">{i.name}</span>
              {i.hint && <span className="text-ink-faint">{i.hint}</span>}
            </label>
          ))}
        </div>
        <label className="mt-2 flex flex-col gap-1 text-[13px]">
          <span className="font-medium">To</span>
          <select className={fieldClass} value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <div className="mt-2 flex items-center justify-end gap-2">
          {pending && <span className="mr-auto text-[13px]"><Moving to={targets.find((w) => w.id === to)?.name ?? "the workspace"} /></span>}
          <Button onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" onClick={move} disabled={pending || !picked.size || !to}>{`Move ${picked.size || ""}`.trim()}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
