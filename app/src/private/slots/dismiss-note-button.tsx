"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { dismissAllNotes, dismissNote } from "@/private/notes/notes-actions";

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

// Above the list when there is more than one note: closes every note shown, at once.
export function DismissAllNotesButton({ ids }: { ids: string[] }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost" size="sm" disabled={pending}
      onClick={() => start(async () => {
        try {
          const r = await dismissAllNotes(ids);
          if (r.ok) toast.success(r.message ?? "Dismissed.");
          else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        }
      })}
    >
      {pending ? "Dismissing…" : `Dismiss all (${ids.length})`}
    </Button>
  );
}
