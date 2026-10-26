"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { recheck } from "./actions";

// Domains → Re-check. It runs a TLS handshake and an RDAP read (a few seconds), so a "Checking…" toast is replaced by
// the result, and a second click while it runs is ignored.
export function RecheckButton({ domainId, name }: { domainId: string; name: string }) {
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const run = () => {
    if (busy.current) return;
    busy.current = true;
    const id = toast.loading(`Checking ${name}. This takes a few seconds.`);
    start(async () => {
      try {
        const r = await recheck(domainId);
        if (!r.ok) toast.error(r.error, { id });
        else toast.success(r.message ?? "", { id });
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.", { id });
      } finally {
        busy.current = false;
      }
    });
  };
  return <Button size="sm" onClick={run} disabled={pending} aria-label={`Re-check ${name}`}>{pending ? "Checking…" : "Re-check"}</Button>;
}
