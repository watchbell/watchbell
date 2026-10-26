"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import { backUpNow, disconnectDrive, startDriveConnect } from "./actions";

// Mockup driveDlg(): what Google will ask, then the browser goes to Google's own consent page and comes back to
// /backups. The console never sees the owner's Google password.
// `quiet`: the connection is fine, so Reconnect is an ordinary button (like "Replace credential" on the other cards),
// not a call to action (owner 20 Oct: the blue button read as "it keeps asking me to reconnect").
export function DriveConnectButton({ reconnect = false, quiet = false, size = "md" }: { reconnect?: boolean; quiet?: boolean; size?: "sm" | "md" }) {
  return (
    <ConfirmDialog
      trigger={<Button size={size} variant={quiet ? "secondary" : "primary"}>{quiet ? "Reconnect" : reconnect ? "Reconnect Google Drive" : "Connect Google Drive"}</Button>}
      title={reconnect ? "Reconnect Google Drive" : "Connect Google Drive"}
      body={
        <>
          <p className="mb-2">Google will ask you to approve one permission:</p>
          <p className="mb-2 rounded-md border border-line bg-sunken px-3 py-2 text-ink-soft">See, edit, create, and delete only the specific Google Drive files you use with this app.</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
            <li>The console can&apos;t see any of your other files.</li>
            <li>It uses one folder: the backups folder it made before, or a new one named Watchbell backups.</li>
            <li>You can remove access any time in your Google Account settings.</li>
          </ul>
        </>
      }
      cta="Continue to Google"
      onConfirm={async () => {
        const r = await startDriveConnect();
        if (!r.ok || !r.data) return { ok: false, message: r.ok ? "Watchbell didn't answer. Check that it's still running, then try again." : r.error };
        window.location.assign(r.data.url);
        return { ok: true, message: "Opening Google…" };
      }}
    />
  );
}

export function DisconnectDriveButton() {
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Disconnect</Button>}
      title="Disconnect Google Drive?"
      body="The console forgets its access and stops the monthly backups. The backups already in your Drive stay where they are."
      cta="Disconnect"
      danger
      onConfirm={async () => {
        const r = await disconnectDrive();
        return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
      }}
    />
  );
}

// Mockup: "Backing up October so far. It will appear here in a few seconds."
export function BackUpNowButton({ monthLabel, disabled }: { monthLabel: string; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const run = () => {
    if (busy.current) return;
    busy.current = true;
    const id = toast.loading(`Backing up ${monthLabel} so far. It will appear here in a few seconds.`);
    start(async () => {
      try {
        const r = await backUpNow();
        if (r.ok) toast.success(r.message ?? "Saved to Google Drive.", { id });
        else toast.error(r.error, { id });
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.", { id });
      } finally {
        busy.current = false;
      }
    });
  };
  return <Button onClick={run} disabled={pending || disabled}>{pending ? "Backing up…" : "Back up now"}</Button>;
}
