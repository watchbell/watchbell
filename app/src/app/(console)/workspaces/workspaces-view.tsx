"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button, Card } from "@/components/kit";
import { Status } from "@/components/status";
import type { WorkspaceSummary } from "@/lib/data/workspace-db";
import { ago } from "@/lib/time";
import { dismissUnsortedAction, switchWorkspace } from "./actions";

// Watchbell 1.8 (spec §5): All workspaces — which client has a problem, worst first; one click opens it.
const RANK = { down: 0, warn: 1, ok: 2 } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Unsorted = { id: string; name: string; kind: string; firstSeenAt: Date };

export function WorkspacesView({ workspaces, install, now, unsorted = [], defaultName = "", canEdit = false }: {
  workspaces: WorkspaceSummary[]; install: { openAlerts: number }; now: number; unsorted?: Unsorted[]; defaultName?: string; canEdit?: boolean;
}) {
  const [pending, start] = useTransition();
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
                      {[w.monitorsDown ? plural(w.monitorsDown, "monitor down", "monitors down") : null, w.openAlerts ? plural(w.openAlerts, "open alert") : null].filter(Boolean).join(" · ")}
                    </Status>
                  )}
                </td>
                <td className="py-2 font-mono">{plural(w.apps, "app")}</td>
                <td className="py-2 text-ink-soft">{w.lastDeployAt ? ago(new Date(w.lastDeployAt), new Date(now)) : "—"}</td>
                <td className="py-2 text-right">
                  <Button size="sm" onClick={() => open(w.id)} disabled={pending} aria-label={`Open ${w.name}`}>Open</Button>
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
              New in the last 14 days and still in {defaultName}, the default workspace. Move them from Applications, Domains, DNS
              records or the database pages, or leave them in {defaultName}.
            </p>
            <ul>
              {unsorted.map((u) => (
                <li key={u.id} className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-ink-faint">{u.kind.replace(/_/g, " ")} · first seen {ago(new Date(u.firstSeenAt), new Date(now))}</span>
                </li>
              ))}
            </ul>
            {canEdit && <div className="mt-2"><Button size="sm" onClick={() => leave(unsorted.map((u) => u.id))} disabled={pending}>Leave in {defaultName}</Button></div>}
          </div>
        </Card>
      )}
    </div>
  );
}
