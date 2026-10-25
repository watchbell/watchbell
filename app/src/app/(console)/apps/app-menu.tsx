"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { useProviderAction } from "@/components/provider-action";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import { confirmCopy } from "@/lib/view/deploy-actions";
import { actionsLabel } from "@/lib/view/labels";
import { pauseAppMonitors } from "../monitor-actions";
import { redeployCurrentAction } from "../vercel-actions";
import { useOnce } from "./use-once";

type MenuApp = { id: string; name: string; siteUrl: string | null; paused: boolean; monitorCount: number };

// The app page's Logs tab (the page reads ?tab=).
export const appLogsHref = (appId: string) => `/apps/${appId}?tab=logs`;

// Applications → row kebab: Redeploy (the app page's confirm and action, on the current production deployment), Open
// site (a link), View logs (the app page's Logs tab) and Pause monitors / Resume monitors, which only changes console
// rows. As on the app page, an app without monitors has nothing to pause.
export function appMenuItems(app: MenuApp, h: { redeploy: () => void; viewLogs: () => void; togglePause: () => void }): MenuEntry[] {
  const items: MenuEntry[] = [
    { label: "Redeploy", onSelect: h.redeploy },
    ...(app.siteUrl ? [{ label: "Open site", href: app.siteUrl }] : []), // null in demo: the host is made up
    { label: "View logs", onSelect: h.viewLogs },
  ];
  if (app.monitorCount > 0) items.push({ label: app.paused ? "Resume monitors" : "Pause monitors", onSelect: h.togglePause });
  return items;
}

export function AppMenu({ app }: { app: MenuApp }) {
  const [, start] = useTransition();
  const once = useOnce();
  const router = useRouter();
  const mask = useMask();
  const provider = useProviderAction();
  const items = appMenuItems(app, {
    // The server refuses it while rolled back or with a build running, with the app page's wording.
    redeploy: () => provider.open({ ...confirmCopy("Redeploy", mask("app", app.name), ""), run: () => redeployCurrentAction(app.id) }),
    viewLogs: () => router.push(appLogsHref(app.id)),
    // A second pick while one is running is ignored.
    togglePause: () => once(() => new Promise<void>((done) => start(async () => {
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
  return (
    <>
      <RowMenu items={items} label={actionsLabel(app.name)} />
      {provider.dialog}
    </>
  );
}
