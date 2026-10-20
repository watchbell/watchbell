"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { dismissRecommendation } from "@/app/(console)/advisor-actions";
import { Button } from "@/components/kit";

// Recommendations → Dismiss (Operator and up; the card doesn't render it for Viewers). The server action refreshes the
// page, so the item is gone when the toast shows.
export function DismissButton({ recKey }: { recKey: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await dismissRecommendation(recKey);
          if (r.ok) toast.success(r.message ?? "Dismissed.");
          else toast.error(r.error);
        } catch {
          toast.error("Something went wrong. Try again.");
        }
      })}
    >
      {pending ? "Dismissing…" : "Dismiss"}
    </Button>
  );
}
