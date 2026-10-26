"use client";

import { IconLoader2, IconPlayerPlay, IconRadar, IconRefresh } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { Switch } from "@/private/ui/switch";
import { makeDefaultModel, refreshAllModels, scanModelsAction, syncModelsNowAction, testModelAction, toggleModel } from "./actions";

export function ModelSwitch({ providerId, modelId, publicId, enabled, disabled }: { providerId: string; modelId: string; publicId: string; enabled: boolean; disabled?: boolean }) {
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  // The server's answer wins: when the page re-renders with another value, follow it (adjusting state while rendering).
  const [seen, setSeen] = useState(enabled);
  if (seen !== enabled) { setSeen(enabled); setOn(enabled); }
  return (
    <Switch
      checked={on}
      disabled={disabled || pending}
      label={`Model ${publicId}`}
      onChange={(next) => {
        setOn(next);
        start(async () => {
          try {
            const r = await toggleModel(providerId, modelId, next);
            if (r.ok) toast.success(r.message ?? "Saved.");
            else { setOn(!next); toast.error(r.error); }
          } catch {
            setOn(!next);
            toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
          }
        });
      }}
    />
  );
}

export function MakeDefaultButton({ publicId }: { publicId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await makeDefaultModel(publicId);
          if (r.ok) toast.success(r.message ?? "Saved."); else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      Make default
    </Button>
  );
}

export function RefreshModelsButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await refreshAllModels();
          if (r.ok) toast.success(r.message ?? "Refreshed."); else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      <IconRefresh size={16} aria-hidden />{pending ? "Refreshing..." : "Refresh models"}
    </Button>
  );
}

// Models › Sync now: the model sync's run (list, diff, tests) now; up to ~50 s.
export function SyncNowButton() {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await syncModelsNowAction();
          if (r.ok) toast.success(r.message ?? "Synced."); else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      {pending ? <IconLoader2 size={15} className="animate-spin" aria-hidden /> : <IconRefresh size={15} aria-hidden />}
      {pending ? "Syncing…" : "Sync now"}
    </Button>
  );
}

// Models › Test (one model) and Scan all (one connection): real provider calls, so they show a spinner and the
// result as a toast; the page re-renders with the stored lastTest.
export function TestModelButton({ providerId, modelId, publicId }: { providerId: string; modelId: string; publicId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" aria-label={`Test ${publicId}`} title={`Test ${publicId}`} disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await testModelAction(providerId, modelId);
          if (r.ok) toast.success(r.message ?? "Works."); else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      {pending ? <IconLoader2 size={15} className="animate-spin" aria-hidden /> : <IconPlayerPlay size={15} aria-hidden />}
    </Button>
  );
}

export function ScanAllButton({ providerId, name }: { providerId: string; name: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await scanModelsAction(providerId);
          if (r.ok) toast.success(r.message ?? "Scanned."); else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      {pending ? <IconLoader2 size={15} className="animate-spin" aria-hidden /> : <IconRadar size={15} aria-hidden />}
      {pending ? `Scanning ${name}…` : `Scan all · ${name}`}
    </Button>
  );
}
