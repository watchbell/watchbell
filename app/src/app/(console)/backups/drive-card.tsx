import { Status } from "@/components/status";
import { ENV_COPY } from "@/lib/copy/edition";
import { DRIVE_ENV_MISSING } from "@/lib/backup/google-oauth";
import type { DriveState } from "@/lib/view/backups";
import { DisconnectDriveButton, DriveConnectButton } from "./drive-buttons";

// The Google Drive state with its one next step, on Backups (mockup backups() first card) and Connections.
export function DriveStateBlock({ state, folderName, showDisconnect = false }: { state: DriveState; folderName: string; showDisconnect?: boolean }) {
  const note = "mt-1.5 text-[12.5px] text-ink-soft";
  switch (state.kind) {
    case "env":
      return (
        <div>
          <Status state="off">Not set up</Status>
          <p className={note}>{DRIVE_ENV_MISSING} Create the OAuth client first (README → Google Drive backups), then {ENV_COPY.apply}.</p>
        </div>
      );
    case "none":
      return (
        <div>
          <Status state="off">Not connected</Status>
          <p className={`${note} mb-2`}>Connect once; the backup then runs by itself on the 1st of every month.</p>
          <DriveConnectButton size="sm" />
        </div>
      );
    case "reconnect":
      return (
        <div>
          <Status state="err">Reconnect needed</Status>
          <p className={`${note} mb-2`}>{state.error}</p>
          <DriveConnectButton size="sm" reconnect />
        </div>
      );
    case "problem":
    case "ok":
      return (
        <div>
          <Status state={state.kind === "ok" ? "ok" : "warn"}>{state.kind === "ok" ? "Connected" : "Connected · last run failed"}</Status>
          <p className={note}>{state.kind === "problem" ? state.error : `Folder: ${folderName}`}</p>
          {showDisconnect && <div className="mt-2 flex gap-1.5"><DriveConnectButton size="sm" reconnect quiet /><DisconnectDriveButton /></div>}
        </div>
      );
  }
}
