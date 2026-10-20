"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { setActionsRepoAction } from "./actions-lockfile-actions";

// Settings › Lockfile via GitHub Actions: the actions repository for lockfile updates (owner/name; empty turns it off).
export function ActionsRepoForm({ current }: { current: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await setActionsRepoAction(value);
    if (r.ok) toast.success(r.message ?? "Saved."); else toast.error(r.error);
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${fieldClass} w-72 font-mono`} placeholder="yourname/watchbell-actions" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Actions repository" />
      <Button size="sm" onClick={save} disabled={pending || value.trim() === (current ?? "")}>{pending ? "Saving…" : "Save"}</Button>
    </div>
  );
}
