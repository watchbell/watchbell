"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { Button } from "@/components/kit";
import { scanDependencies } from "./deps-actions";

// App page → Dependencies → Scan now. It downloads the lockfile and asks OSV.dev (up to ~40 s), so a toast says it's
// running and is replaced by the result; a second click while it runs is ignored.
export function DepsScanButton({ appId, appName }: { appId: string; appName: string }) {
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const mask = useMask();
  const run = () => {
    if (busy.current) return;
    busy.current = true;
    const id = toast.loading(`Scanning the dependencies of ${mask("app", appName)}. This can take up to half a minute.`);
    start(async () => {
      try {
        const r = await scanDependencies(appId);
        if (!r.ok) toast.error(r.error, { id });
        else if (r.data?.vulns) toast.warning(r.message ?? "", { id });
        else toast.success(r.message ?? "", { id });
      } catch {
        toast.error("Something went wrong. Try again.", { id });
      } finally {
        busy.current = false;
      }
    });
  };
  return <Button size="sm" onClick={run} disabled={pending}>{pending ? "Scanning…" : "Scan now"}</Button>;
}
