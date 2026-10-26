"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { RowMenu } from "@/components/row-menu";
import { silence } from "./actions";

type Props = { id: string; label: string; silenced: boolean; resourceHref: string | null };

// Silence is Owner or Operator and needs no confirmation (spec §12); the result replaces nothing, it only toasts.
export function AlertMenu({ id, label, silenced, resourceHref }: Props) {
  const [, start] = useTransition();
  const busy = useRef(false);
  const run = (choice: "1h" | "resolved" | "off") => {
    if (busy.current) return;
    busy.current = true;
    start(async () => {
      try {
        const r = await silence(id, choice);
        if (r.ok) toast.success(r.message ?? "");
        else toast.error(r.error);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      } finally {
        busy.current = false;
      }
    });
  };
  const view = resourceHref ? [{ label: "View resource", href: resourceHref }] : [];
  return (
    <RowMenu label={`Actions for ${label}`} items={silenced
      ? [{ label: "Unsilence", onSelect: () => run("off") }, ...view]
      : [{ label: "Silence 1 hour", onSelect: () => run("1h") }, { label: "Silence until resolved", onSelect: () => run("resolved") }, ...view]} />
  );
}
