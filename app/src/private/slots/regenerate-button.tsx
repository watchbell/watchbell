"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { regenerateSummary } from "@/private/assist/actions";

// "Regenerate" in the summary's meta line (and "Summarise" when none exists yet). The action refreshes the page.
export function RegenerateButton({ label }: { label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost" size="sm" disabled={pending} className="-my-0.5 px-1 py-0"
      onClick={() => start(async () => {
        try {
          const r = await regenerateSummary();
          if (r.ok) toast.success(r.message ?? "Done.");
          else toast.error(r.error);
        } catch {
          toast.error("Something went wrong. Try again.");
        }
      })}
    >
      {pending ? "Working…" : label}
    </Button>
  );
}
