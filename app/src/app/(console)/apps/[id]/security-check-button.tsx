"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { Button } from "@/components/kit";
import { checkSecurity } from "./security-actions";

// App page → Security → Check now. It reads the live site and asks OSV.dev (up to ~20 s), so a "Checking…" toast is
// replaced by the result, and a second click while it runs is ignored.
export function SecurityCheckButton({ appId, appName }: { appId: string; appName: string }) {
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const mask = useMask();
  const run = () => {
    if (busy.current) return;
    busy.current = true;
    const id = toast.loading(`Checking ${mask("app", appName)}. The result shows here in a few seconds.`);
    start(async () => {
      try {
        const r = await checkSecurity(appId);
        if (!r.ok) toast.error(r.error, { id });
        else if (r.data?.passed === false || r.data?.vulnerable) toast.warning(r.message ?? "", { id });
        else toast.success(r.message ?? "", { id });
      } catch {
        toast.error("Something went wrong. Try again.", { id });
      } finally {
        busy.current = false;
      }
    });
  };
  return <Button size="sm" onClick={run} disabled={pending}>{pending ? "Checking…" : "Check now"}</Button>;
}
