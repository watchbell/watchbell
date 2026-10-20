"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import { actionsLabel } from "@/lib/view/labels";
import { pauseAppMonitors } from "../monitor-actions";
import { useOnce } from "./use-once";

// Applications → row kebab. Redeploy arrives in stage 6 and View logs in stage 5 (R4); Open site is a link;
// Pause monitors / Resume monitors is real and only changes console rows. As on the app page, an app without monitors
// has nothing to pause, and a second pick while one is running is ignored.
export function AppMenu({ app }: { app: { id: string; name: string; siteUrl: string | null; paused: boolean; monitorCount: number } }) {
  const [, start] = useTransition();
  const once = useOnce();
  const items: MenuEntry[] = [
    { label: "Redeploy", later: 6 },
    ...(app.siteUrl ? [{ label: "Open site", href: app.siteUrl }] : []), // null in demo: the host is made up
    { label: "View logs", later: 5 },
  ];
  if (app.monitorCount > 0) {
    items.push({
      label: app.paused ? "Resume monitors" : "Pause monitors",
      onSelect: () => once(() => new Promise<void>((done) => start(async () => {
        try {
          const r = await pauseAppMonitors(app.id, !app.paused);
          if (r.ok) toast.success(r.message ?? "");
          else toast.error(r.error);
        } catch {
          toast.error("Something went wrong. Try again.");
        } finally {
          done();
        }
      }))),
    });
  }
  return <RowMenu items={items} label={actionsLabel(app.name)} />;
}
