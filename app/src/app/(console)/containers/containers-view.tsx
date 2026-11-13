"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { StateIcon } from "@/components/status";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ListedContainer } from "@/lib/data/docker-db";
import type { ContainerDetail, ContainerVerb } from "@/lib/docker/client";
import type { State } from "@/lib/status";
import { containerDetailAction, containerListAction, containerVerbAction } from "./containers-actions";

// The Containers list and one container's drawer: logs tail (masked), one CPU/memory reading, restarts, and the owner's
// start / stop / restart. Stop and restart ask for the container's name typed back.

export function containerState(c: Pick<ListedContainer, "state" | "health">): State {
  if (c.health === "unhealthy") return "err";
  if (c.state === "restarting" || c.health === "starting") return "warn";
  if (c.state === "running") return "ok";
  if (c.state === "paused") return "paused";
  return "off";
}

export const bytes = (n: number | null): string =>
  n === null ? "—" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`;

const UNREACHABLE = "Watchbell didn't answer. Check that it's still running, then try again.";

export function ContainersView({ initial, owner }: { initial: ListedContainer[]; owner: boolean }) {
  const [list, setList] = useState(initial);
  const [open, setOpen] = useState<ListedContainer | null>(null);
  const [pending, start] = useTransition();
  const refresh = () => start(async () => {
    try {
      const r = await containerListAction();
      if (r.ok && r.data) setList(r.data.containers); else toast.error(r.ok ? "No answer." : r.error);
    } catch {
      toast.error(UNREACHABLE);
    }
  });
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-[18px] pb-2 pt-3">
        <span className="text-[12.5px] text-ink-soft">{list.length} container{list.length === 1 ? "" : "s"}</span>
        <Button size="sm" onClick={refresh} disabled={pending}>{pending ? "Refreshing…" : "Refresh"}</Button>
      </div>
      {list.length === 0 ? (
        <p className="px-[18px] pb-4 text-ink-soft">No containers on this machine.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-ink-soft">
              <tr className="border-y border-line">
                <th className="px-[18px] py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium max-[720px]:hidden">Image</th>
                <th className="px-3 py-2 font-medium max-[720px]:hidden">Ports</th>
                <th className="px-[18px] py-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="px-[18px] py-2.5">
                    <span className="inline-flex items-center gap-1.5 font-medium"><StateIcon state={containerState(c)} />{c.name}</span>
                    {c.self && <span className="ml-1.5 text-[12px] text-ink-soft">(Watchbell)</span>}
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">{c.status || c.state}</td>
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-soft max-[720px]:hidden">{c.image}</td>
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-soft max-[720px]:hidden">{c.ports.join(", ") || "—"}</td>
                  <td className="px-[18px] py-2.5 text-right"><Button size="sm" onClick={() => setOpen(c)}>Details</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ContainerDrawer container={open} owner={owner} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  );
}

function ContainerDrawer({ container, owner, onClose, onChanged }: { container: ListedContainer; owner: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ContainerVerb | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, startBusy] = useTransition();
  useHoldRefresh(true);

  useEffect(() => {
    // A read that comes back after the drawer closed is dropped (as in the build-logs drawer).
    let live = true;
    containerDetailAction(container.id)
      .then((r) => { if (live) { if (r.ok && r.data) setDetail(r.data); else setError(r.ok ? "No answer." : r.error); } })
      .catch(() => { if (live) setError(UNREACHABLE); });
    return () => { live = false; };
  }, [container.id]);

  const run = (verb: ContainerVerb) => startBusy(async () => {
    try {
      const r = await containerVerbAction(container.id, verb, verb === "start" ? "" : typed);
      if (r.ok) { toast.success(r.message ?? "Done."); setConfirm(null); setTyped(""); onChanged(); onClose(); } else toast.error(r.error);
    } catch {
      toast.error(UNREACHABLE);
    }
  });

  const running = container.state === "running" || container.state === "restarting";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogTitle>{container.name}</DialogTitle>
        <DialogDescription className="font-mono text-[12.5px]">{container.image} · {container.status || container.state}</DialogDescription>
        {error && <p className="flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>{error}</span></p>}
        {!detail && !error && <p className="text-ink-soft">Reading the container…</p>}
        {detail && (
          <>
            <p className="text-[13px] text-ink-soft">
              CPU {detail.stats.cpuPct === null ? "—" : `${detail.stats.cpuPct}%`} · memory {bytes(detail.stats.memBytes)}{detail.stats.memLimit ? ` of ${bytes(detail.stats.memLimit)}` : ""} · restarted {detail.restarts} time{detail.restarts === 1 ? "" : "s"}
            </p>
            <pre tabIndex={0} aria-label="Last log lines" className="max-h-[320px] overflow-auto rounded-md bg-code-bg p-3 font-mono text-[12px] leading-relaxed text-code-text">
              {detail.logs.length ? detail.logs.join("\n") : "(no log lines)"}
            </pre>
            <p className="text-[12px] text-ink-faint">The last {detail.logs.length} lines. Values that look secret are masked.</p>
          </>
        )}
        {owner && !container.self && (
          confirm ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="ctr-confirm" className="text-[13px]">Type <span className="font-mono">{container.name}</span> to {confirm}:</label>
              <input id="ctr-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className={`${fieldClass} w-[220px]`} autoComplete="off" />
              <Button size="sm" variant="danger" onClick={() => run(confirm)} disabled={busy || typed.trim() !== container.name}>{busy ? "Working…" : confirm === "stop" ? "Stop" : "Restart"}</Button>
              <Button size="sm" onClick={() => { setConfirm(null); setTyped(""); }} disabled={busy}>Cancel</Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!running && <Button size="sm" onClick={() => run("start")} disabled={busy}>{busy ? "Starting…" : "Start"}</Button>}
              {running && <Button size="sm" onClick={() => setConfirm("restart")} disabled={busy}>Restart</Button>}
              {running && <Button size="sm" variant="danger" onClick={() => setConfirm("stop")} disabled={busy}>Stop</Button>}
            </div>
          )
        )}
        {owner && container.self && <p className="text-[12.5px] text-ink-soft">This is the container Watchbell runs in, so it can&apos;t be stopped or restarted from here.</p>}
      </DialogContent>
    </Dialog>
  );
}
