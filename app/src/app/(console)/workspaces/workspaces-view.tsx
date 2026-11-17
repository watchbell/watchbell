"use client";

import { useRouter } from "next/navigation";
import { IconChevronDown } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Card } from "@/components/kit";
import { Moving } from "@/components/moving";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/status";
import type { WorkspaceSummary } from "@/lib/data/workspace-db";
import { ago } from "@/lib/time";
import { dismissUnsortedAction, moveToWorkspace, switchWorkspace } from "./actions";

// Watchbell 1.8 (spec §5): All workspaces — which client has a problem, worst first; one click opens it.
const RANK = { down: 0, warn: 1, ok: 2 } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Unsorted = { id: string; name: string; kind: string; firstSeenAt: Date };
type Ws = { id: string; name: string };

// The row's words when something is wrong: apps first (what Overview shows), then monitors and alerts.
export const problemText = (w: WorkspaceSummary): string => [
  w.appsDown ? plural(w.appsDown, "app down", "apps down") : null,
  w.appsWarn ? plural(w.appsWarn, "app degraded", "apps degraded") : null,
  w.monitorsDown ? plural(w.monitorsDown, "monitor down", "monitors down") : null,
  w.openAlerts ? plural(w.openAlerts, "open alert") : null,
].filter(Boolean).join(" · ");

// 1.8.3 (1.8.1 deferred minor): while one not-sorted item moves, the other items and Open / Leave wait. The lock lifts
// when the moved item leaves the note (the server's refresh) or the move fails (moving is cleared).
export function notSortedLocked(pending: boolean, moving: string | null, unsorted: readonly { id: string }[]): boolean {
  return pending || (moving !== null && unsorted.some((u) => u.id === moving));
}

export function WorkspacesView({ workspaces, install, now, unsorted = [], defaultName = "", canEdit = false, targets = [] }: {
  workspaces: WorkspaceSummary[]; install: { openAlerts: number }; now: number; unsorted?: Unsorted[]; defaultName?: string; canEdit?: boolean;
  // 1.8.1: where a not-sorted item can go (every workspace but the default).
  targets?: Ws[];
}) {
  const [pending, start] = useTransition();
  const [moving, setMoving] = useState<string | null>(null);
  const locked = notSortedLocked(pending, moving, unsorted);
  const router = useRouter();
  const open = (id: string) => start(async () => {
    const r = await switchWorkspace(id);
    if (r.ok) router.push("/");
    else toast.error(r.error);
  });
  const leave = (ids: string[]) => start(async () => {
    const r = await dismissUnsortedAction(ids);
    if (r.ok) toast.success(r.message ?? "Done.");
    else toast.error(r.error);
  });
  const sorted = [...workspaces].sort((a, b) => RANK[a.worst] - RANK[b.worst] || a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-3">
      {install.openAlerts > 0 && (
        <Card>
          <div className="text-[13px]">
            <Status state="warn">{plural(install.openAlerts, "open alert")} about this install</Status>
            <span className="ml-2 text-ink-soft">(the collector, backups or this machine; shown in every workspace)</span>
          </div>
        </Card>
      )}
      <Card title="All workspaces">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-ink-soft">
              <th className="py-1.5 font-medium">Workspace</th>
              <th className="py-1.5 font-medium">State</th>
              <th className="py-1.5 font-medium">Apps</th>
              <th className="py-1.5 font-medium">Last deploy</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((w) => (
              <tr key={w.id} className="border-t border-line">
                <td className="py-2 font-medium">{w.name}</td>
                <td className="py-2">
                  {w.worst === "ok" ? <Status state="ok">All up</Status> : (
                    <Status state={w.worst === "down" ? "err" : "warn"}>
                      {problemText(w)}
                    </Status>
                  )}
                </td>
                <td className="py-2 font-mono">{plural(w.apps, "app")}</td>
                <td className="py-2 text-ink-soft">{w.lastDeployAt ? ago(new Date(w.lastDeployAt), new Date(now)) : "—"}</td>
                <td className="py-2 text-right">
                  <Button size="sm" onClick={() => open(w.id)} disabled={locked} aria-label={`Open ${w.name}`}>Open</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {unsorted.length > 0 && (
        <Card title="Not sorted yet">
          <div id="unsorted" className="text-[13px]">
            <p className="mb-2 text-ink-soft">
              New in the last 14 days and still in {defaultName}, the default workspace. Move each one to its workspace here (or
              from Applications, Domains, DNS records or the database pages), or leave them in {defaultName}.
            </p>
            <ul>
              {unsorted.map((u) => (
                <li key={u.id} className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-ink-faint">{u.kind.replace(/_/g, " ")} · first seen {ago(new Date(u.firstSeenAt), new Date(now))}</span>
                  {canEdit && targets.length > 0 && <span className="ml-auto"><MoveItem item={u} targets={targets} disabled={locked} onMoving={setMoving} /></span>}
                </li>
              ))}
            </ul>
            {canEdit && <div className="mt-2"><Button size="sm" onClick={() => leave(unsorted.map((u) => u.id))} disabled={locked}>Leave in {defaultName}</Button></div>}
          </div>
        </Card>
      )}
    </div>
  );
}

// 1.8.1 (owner, 15 Nov): one not-sorted thing to another workspace, from the note. While it runs: a spinner and
// "Moving to <workspace>…"; then a toast, and the server's refresh takes the item out of the note.
// One move, then the spinner and the note's lock go. The transition settles after the action's refresh, so a moved
// item has already left the note by then; one that didn't move (final review 1.8.3 M4: the target was deleted
// meanwhile) is usable again instead of locking the note.
export async function moveOne(item: Unsorted, to: Ws, d: {
  move: typeof moveToWorkspace; success: (m: string) => void; error: (m: string) => void; setMoving: (v: string | null) => void; onMoving: (id: string | null) => void;
}): Promise<void> {
  const r = await d.move("resource", [item.id], to.id);
  if (r.ok) d.success(r.message ?? `${item.name} moved to ${to.name}.`);
  else d.error(r.error);
  d.setMoving(null);
  d.onMoving(null);
}

function MoveItem({ item, targets, disabled, onMoving }: { item: Unsorted; targets: Ws[]; disabled: boolean; onMoving: (id: string | null) => void }) {
  const [moving, setMoving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const move = (to: Ws) => {
    setMoving(to.name);
    onMoving(item.id);
    start(() => moveOne(item, to, { move: moveToWorkspace, success: (m) => toast.success(m), error: (m) => toast.error(m), setMoving, onMoving }));
  };
  if (moving) return <Moving to={moving} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Move ${item.name} to another workspace`}
        disabled={disabled || pending}
        className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        Move to…<IconChevronDown size={13} stroke={1.75} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel>Move {item.name} to</DropdownMenuLabel>
        {targets.map((w) => <DropdownMenuItem key={w.id} onClick={() => move(w)}>{w.name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
