"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { refreshNow } from "@/app/(console)/refresh-action";
import { Button } from "@/components/kit";

// Mockup section 8: header action on Overview, Applications and Uptime (owner, 13 Oct: so a test ping's new state shows
// without a hard browser refresh). Hidden for viewers by the page.
export function RefreshButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() => start(async () => {
        const r = await refreshNow();
        if (r.ok) toast.success("Action sent", { description: r.message });
        else toast.error(r.error);
      })}
    >
      <IconRefresh size={16} aria-hidden />
      {pending ? "Refreshing…" : "Refresh now"}
    </Button>
  );
}
