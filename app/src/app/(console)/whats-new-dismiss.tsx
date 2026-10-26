"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { dismissWhatsNew } from "./update-actions";

// 1.2.3: hides the What's new banner until the next update.
export function WhatsNewDismiss() {
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    try {
      const r = await dismissWhatsNew();
      if (!r.ok) toast.error(r.error);
    } catch {
      toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
    }
  });
  return <Button size="sm" onClick={run} disabled={pending}>{pending ? "Saving…" : "Got it"}</Button>;
}
