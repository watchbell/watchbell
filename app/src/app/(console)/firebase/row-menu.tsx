"use client";

import { toast } from "sonner";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import { runHealthCheckAction } from "./actions";

// Firebase row kebab: the console links (left out in demo) and Run health check (1.2.1), the 5-minute Firestore read
// now. A read, so no dialog; the toast carries the answer and the Health column updates.
export function FirestoreRowMenu({ id, label, alias, links }: { id: string; label: string; alias: string; links: { label: string; href: string }[] }) {
  const run = () => {
    const t = toast.loading(`Checking ${alias}…`);
    runHealthCheckAction(id)
      .then((r) => (r.ok ? toast.success(`${alias}: ${r.message ?? "checked"}`, { id: t }) : toast.error(`${alias}: ${r.error}`, { id: t })))
      .catch(() => toast.error("Something went wrong. Try again.", { id: t }));
  };
  const items: MenuEntry[] = [...links, { label: "Run health check", onSelect: run }];
  return <RowMenu label={label} items={items} />;
}
