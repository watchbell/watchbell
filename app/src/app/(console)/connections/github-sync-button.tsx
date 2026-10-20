"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { syncGithubNow } from "./github-actions";

// GitHub's Sync has nothing to tick: every repository the token sees is listed, and apps are linked on their own page.
export function GithubSyncButton({ accountId }: { accountId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm" disabled={pending}
      onClick={() => start(async () => {
        const id = toast.loading("Syncing GitHub…");
        try {
          const r = await syncGithubNow(accountId);
          if (r.ok) toast.success(r.message ?? "Synced.", { id });
          else toast.error(r.error, { id });
        } catch {
          toast.error("Something went wrong. Try again.", { id });
        }
      })}
    >
      <IconRefresh size={14} aria-hidden />{pending ? "Syncing…" : "Sync"}
    </Button>
  );
}
