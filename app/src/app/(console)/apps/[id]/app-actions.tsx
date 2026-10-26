"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProviderActionButton, useProviderAction } from "@/components/provider-action";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import { confirmCopy } from "@/lib/view/deploy-actions";
import { pauseAppMonitors } from "../../monitor-actions";
import { promoteAction, redeployAction, rollbackAction } from "../../vercel-actions";
import { removeAppFromConsole } from "../actions";
import { useOnce } from "../use-once";

// A deployment the app page's actions act on: Vercel's id and its short commit.
export type DeployRef = { id: string; sha: string } | null;

// App page → "Actions ▾" (mockup details.app): Redeploy the current production deployment, Roll back to the previous
// one (stage 6, each confirmed, A3), Open site, Pause monitors and the owner's "Remove from console". The dialogs are
// rendered here, outside the menu, so they survive the page's refresh.
export function AppActions({ app, owner, current, previous, rolledBack = false }: {
  app: { id: string; name: string; siteUrl: string | null; paused: boolean; monitorCount: number }; owner: boolean; current: DeployRef; previous: DeployRef;
  rolledBack?: boolean;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const mask = useMask();
  const [, start] = useTransition();
  const once = useOnce();
  const provider = useProviderAction();
  const name = mask("app", app.name);
  const items: MenuEntry[] = [
    // A9: while rolled back a redeploy would stay staged (the server refuses it); the banner's Promote is the way out.
    rolledBack ? { label: "Redeploy", disabled: "Promote one first" }
      : current
        ? { label: "Redeploy", onSelect: () => provider.open({ ...confirmCopy("Redeploy", name, current.sha), run: () => redeployAction(app.id, current.id) }) }
        : { label: "Redeploy", disabled: "No current production deployment" },
    previous
      ? { label: "Roll back", onSelect: () => provider.open({ ...confirmCopy("Roll back", name, previous.sha), run: () => rollbackAction(app.id, previous.id) }) }
      : { label: "Roll back", disabled: "No previous production deployment" },
    ...(app.siteUrl ? [{ label: "Open site", href: app.siteUrl }] : []), // null in demo: the host is made up
  ];
  // With no monitors there is nothing to pause or resume. A second pick while one is running is ignored (a ref, so
  // two picks inside one render can't both pass, which the transition's `pending` couldn't promise).
  if (app.monitorCount > 0) {
    items.push({
      label: app.paused ? "Resume monitors" : "Pause monitors",
      onSelect: () => once(() => new Promise<void>((done) => start(async () => {
        try {
          const r = await pauseAppMonitors(app.id, !app.paused);
          if (r.ok) toast.success(r.message ?? "");
          else toast.error(r.error);
        } catch {
          toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
        } finally {
          done();
        }
      }))),
    });
  }
  if (owner) items.push("---", { label: "Remove from console", danger: true, onSelect: () => setRemoveOpen(true) });
  return (
    <>
      <RowMenu button items={items} />
      {provider.dialog}
      {owner && (
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={`Remove ${mask("app", app.name)} from the console?`}
          body="Its monitors, history, and alerts are deleted from the console. The Vercel project itself isn't touched."
          cta="Remove"
          danger
          onConfirm={async () => {
            // Success redirects to /apps from the server, so only a failure comes back here.
            const r = await removeAppFromConsole(app.id);
            return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
          }}
        />
      )}
    </>
  );
}

// A9: the rolled-back banner's Promote, for the newest staged production deployment.
export function PromoteStaged({ app, staged }: { app: { id: string; name: string }; staged: { id: string; sha: string } }) {
  const mask = useMask();
  return <ProviderActionButton label="Promote" {...confirmCopy("Promote", mask("app", app.name), staged.sha)} run={() => promoteAction(app.id, staged.id)} />;
}
