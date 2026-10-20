"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RowMenu } from "@/components/row-menu";
import { actionsLabel } from "@/lib/view/labels";
import { checkNow, newPingUrl, pauseMonitor, recordTestPingAction, removeMonitor } from "../monitor-actions";
import { type EditableMonitor, MonitorDialog } from "./monitor-dialog";
import { PingUrlDialog } from "./ping-url-dialog";

type Props = { monitor: EditableMonitor & { path: string; ownerPaused: boolean } };

export function MonitorMenu({ monitor }: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [pingUrl, setPingUrl] = useState<string | null>(null);
  const [, start] = useTransition();
  const busy = useRef(false);
  const heartbeat = monitor.kind === "heartbeat";
  const title = heartbeat ? `${monitor.appName} · ${monitor.path}` : `${monitor.appName}${monitor.path}`;
  // Check now can take up to the monitor's timeout, so it shows a "Checking…" toast that the result replaces, and a
  // second click while it runs is ignored (it would only hit "the collector is running").
  const run = (fn: () => ReturnType<typeof checkNow>, loading?: string) => {
    if (busy.current) return;
    busy.current = true;
    const id = loading ? toast.loading(loading) : undefined;
    start(async () => {
      try {
        const r = await fn();
        if (!r.ok) toast.error(r.error, { id });
        else if (r.data?.passed === false) toast.warning(r.message ?? "", { id });
        else toast.success(r.message ?? "", { id });
      } catch {
        toast.error("Something went wrong. Try again.", { id });
      } finally {
        busy.current = false;
      }
    });
  };
  const pause = { label: monitor.ownerPaused ? "Resume" : "Pause", onSelect: () => run(() => pauseMonitor(monitor.id, !monitor.ownerPaused)) };
  const edit = { label: "Edit monitor", onSelect: () => setEditOpen(true) };
  // U3 (mockup): a heartbeat has no Check now (the console never fetches it). Show ping URL makes a new one, since
  // the console keeps only the old one's hash.
  const first = heartbeat
    ? { label: "Show ping URL", onSelect: () => setRotateOpen(true) }
    : { label: "Check now", onSelect: () => run(() => checkNow(monitor.id), `Checking ${title}…`) };
  return (
    <>
      <RowMenu label={actionsLabel(monitor.appName, monitor.path)} items={[
        first,
        ...(heartbeat ? [
          { label: "Record a test ping: OK", onSelect: () => run(() => recordTestPingAction(monitor.id, "ok")) },
          { label: "Record a test ping: Fail", onSelect: () => run(() => recordTestPingAction(monitor.id, "fail")) },
        ] : []),
        edit, pause,
        "---",
        { label: "Delete", danger: true, onSelect: () => setDeleteOpen(true) },
      ]} />
      {editOpen && <MonitorDialog mode="edit" monitor={monitor} open onOpenChange={setEditOpen} />}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${title}?`}
        body={heartbeat ? "Its ping URL stops working. This can't be undone." : "This can't be undone."}
        cta="Delete"
        danger
        onConfirm={async () => {
          const r = await removeMonitor(monitor.id);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
      {heartbeat && (
        <>
          <ConfirmDialog
            open={rotateOpen}
            onOpenChange={setRotateOpen}
            title={`New ping URL for ${monitor.path}?`}
            body="Make a new ping URL? The old one stops working, so update your job."
            cta="Make a new URL"
            onConfirm={async () => {
              const r = await newPingUrl(monitor.id);
              if (r.ok && r.data?.pingUrl) setPingUrl(r.data.pingUrl);
              return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
            }}
          />
          <PingUrlDialog name={monitor.path} url={pingUrl} onClose={() => setPingUrl(null)} />
        </>
      )}
    </>
  );
}
