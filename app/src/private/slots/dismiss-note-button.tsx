"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { dismissNote } from "@/private/notes/notes-actions";

export function DismissNoteButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost" size="sm" disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await dismissNote(id);
          if (r.ok) toast.success(r.message ?? "Dismissed.");
          else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      {pending ? "Dismissing…" : "Dismiss"}
    </Button>
  );
}
