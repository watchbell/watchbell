"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { MaskedText } from "@/components/alias";
import { Button } from "@/components/kit";
import { updateMonitorDomain } from "../monitor-actions";

// Watchbell 1.2.1: the app moved to a new domain and this monitor still checks the old one. Shown on Uptime and on the
// app page instead of reading as the app being down; Update monitor (owner/operator) points it at the new domain,
// keeping the path.
export function DomainMoved({ monitorId, from, to, canAct }: { monitorId: string; from: string; to: string; canAct: boolean }) {
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[13px] text-warn">
      <span>Domain changed: <MaskedText text={from} /> → <MaskedText text={to} />{canAct ? ", update monitor?" : ""}</span>
      {canAct && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => start(async () => {
            try {
              const r = await updateMonitorDomain(monitorId);
              if (r.ok) toast.success(r.message ?? "Monitor updated.");
              else toast.error(r.error);
            } catch {
              toast.error("Something went wrong. Try again.");
            }
          })}
        >
          {pending ? "Updating…" : "Update monitor"}
        </Button>
      )}
    </span>
  );
}
