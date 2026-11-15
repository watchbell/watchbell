"use client";

import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  createWorkspaceAction, deleteWorkspaceAction, renameWorkspaceAction, reorderWorkspacesAction, setDefaultWorkspaceAction,
} from "@/app/(console)/workspaces/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, Card, fieldClass, IconButton, Tag } from "@/components/kit";
import { cn } from "@/lib/utils";

// Watchbell 1.8 (spec §5): Settings › Workspaces, owner only. A workspace groups one client's apps, monitors, alerts,
// reports and status page; everyone who can sign in sees every workspace.
type Ws = { id: string; name: string; position: number };

export function WorkspacesTab({ list, defaultId }: { list: Ws[]; defaultId: string }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Ws | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) => start(async () => {
    const r = await fn();
    if (r.ok) {
      if (r.message) toast.success(r.message);
      after?.();
    } else toast.error(r.error);
  });
  const add = () => start(async () => {
    const r = await createWorkspaceAction(name);
    if (r.ok) {
      toast.success(r.message ?? "Created.");
      setName("");
      setError(null);
    } else setError(r.error);
  });
  const move = (i: number, by: -1 | 1) => {
    const ids = list.map((w) => w.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    run(() => reorderWorkspacesAction(ids));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card title="Workspaces">
        <p className="mb-3 text-[12.5px] text-ink-soft">
          One workspace per client: its apps, databases, domains, monitors, alerts, reports and status page. Everyone
          who can sign in sees every workspace with their usual role. New apps, databases and domains land in the
          default workspace; move them from Applications, Domains or Uptime.
        </p>
        <ul className="flex flex-col">
          {list.map((w, i) => (
            <li key={w.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0">
              {editing?.id === w.id ? (
                <input className={cn(fieldClass, "max-w-[280px]")} value={editing.name} maxLength={60} autoFocus aria-label={`New name for ${w.name}`}
                  onChange={(e) => setEditing({ id: w.id, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") run(() => renameWorkspaceAction(w.id, editing.name), () => setEditing(null)); if (e.key === "Escape") setEditing(null); }} />
              ) : <span className="font-medium">{w.name}</span>}
              {w.id === defaultId && <Tag>Default</Tag>}
              <span className="ml-auto flex items-center gap-1.5">
                <IconButton label={`Move ${w.name} up`} onClick={() => move(i, -1)} disabled={pending || i === 0}><IconArrowUp size={14} /></IconButton>
                <IconButton label={`Move ${w.name} down`} onClick={() => move(i, 1)} disabled={pending || i === list.length - 1}><IconArrowDown size={14} /></IconButton>
                {editing?.id === w.id
                  ? <Button size="sm" onClick={() => run(() => renameWorkspaceAction(w.id, editing.name), () => setEditing(null))} disabled={pending}>Save</Button>
                  : <Button size="sm" onClick={() => setEditing({ id: w.id, name: w.name })}>Rename</Button>}
                {w.id !== defaultId && (
                  <>
                    <Button size="sm" onClick={() => run(() => setDefaultWorkspaceAction(w.id))} disabled={pending} aria-label={`Make ${w.name} the default`}>Make default</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(w)} disabled={pending} aria-label={`Delete ${w.name}`}>Delete</Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="New workspace">
        <div className="flex flex-wrap items-start gap-2">
          <label className="flex min-w-[240px] flex-col gap-1 text-[13px]">
            <span className="sr-only">Name</span>
            <input className={fieldClass} value={name} maxLength={60} placeholder="e.g. Kopi Senja" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
            {error && <span className="text-[12.5px] text-err" role="alert">{error}</span>}
          </label>
          <Button variant="primary" onClick={add} disabled={pending || !name.trim()}>Create</Button>
        </div>
      </Card>
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          body="Its apps, databases, domains, monitors, reports and repositories move to the default workspace with all their history. Its status page is removed."
          cta="Delete" danger
          onConfirm={async () => {
            const r = await deleteWorkspaceAction(deleting.id);
            return r.ok ? { ok: true, message: r.message ?? "Deleted." } : { ok: false, message: r.error };
          }} />
      )}
    </div>
  );
}
