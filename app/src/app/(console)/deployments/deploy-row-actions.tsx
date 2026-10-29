"use client";

import { useState } from "react";
import { useMask } from "@/components/alias";
import { Button, buttonClass } from "@/components/kit";
import { useProviderAction } from "@/components/provider-action";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import type { ActionResult } from "@/lib/action";
import { confirmCopy, type DeployActionLabel } from "@/lib/view/deploy-actions";
import { actionsLabel } from "@/lib/view/labels";
import { cancelAction, promoteAction, promotePreviewAction, redeployAction, rollbackAction } from "../vercel-actions";
import { BuildLogsDrawer } from "./build-logs-drawer";
import { ReleaseNotesDrawer } from "./release-notes-drawer";

// Stage 6: a deployment row's actions, as the mockup's depRow() and actions() decide them. Visit is a link; the Vercel
// actions open the confirm dialog (A3) and call the server action with the ids this row showed. Up to two show as
// buttons, more go in the row's menu. View build logs (Task 4) opens the drawer: a button for a building or failed
// deployment, a menu item for a ready one. What changed (1.3) opens its own drawer from the menu. Rows are only
// rendered with actions for operators and owners.
export type DeployRowProps = {
  // `visit` is false in demo, where the deployment url is made up: no Visit link. `primaryDomain` is only passed for the
  // app's current production deployment (1.2.1): Visit opens that domain and the deployment url becomes a second link.
  d: { appId: string; appName: string; externalId: string; sha: string | null; url: string | null; visit: boolean; primaryDomain?: string | null };
  actions: DeployActionLabel[];
  // "button": building or failed; "menu": ready; null: no build log offered (canceled).
  logs: "button" | "menu" | null;
  // 1.3: What changed, for a ready production deployment with a commit (offersChanges).
  changes?: boolean;
  // 1.3: Explain with AI in the build-logs drawer (owner, AI extension, a failed build).
  explain?: boolean;
};

function runFor(label: DeployActionLabel, appId: string, id: string): () => Promise<ActionResult> {
  switch (label) {
    case "Redeploy": return () => redeployAction(appId, id);
    case "Roll back to this": return () => rollbackAction(appId, id);
    case "Promote": return () => promoteAction(appId, id);
    case "Cancel": return () => cancelAction(appId, id);
    case "Promote to production": return () => promotePreviewAction(appId, id);
  }
}

export type RowItem = { label: string; kind: "visit" | "logs" | "changes" | "action"; action?: DeployActionLabel };
const LOGS: RowItem = { label: "View build logs", kind: "logs" };
const CHANGES: RowItem = { label: "What changed", kind: "changes" };

// Which items are buttons and which sit in the row menu. Pure (tested).
export function rowLayout(p: Pick<DeployRowProps, "actions" | "logs" | "changes"> & { visit: boolean }): { buttons: RowItem[]; menu: RowItem[] } {
  const items: RowItem[] = [
    ...(p.visit && p.logs !== "button" ? [{ label: "Visit", kind: "visit" as const }] : []),
    ...p.actions.map((a) => ({ label: a, kind: "action" as const, action: a })),
    ...(p.logs === "button" ? [LOGS] : []),
  ];
  const extra = [...(p.logs === "menu" ? [LOGS] : []), ...(p.changes ? [CHANGES] : [])];
  return items.length > 2 ? { buttons: [], menu: [...items, ...extra] } : { buttons: items, menu: extra };
}

// Where Visit goes. The current production row opens the app's own domain (fallback: the deployment url) and keeps the
// deployment url as `deployment`; every other row opens its deployment url. Pure (tested).
export function visitLinks(d: { url: string | null; primaryDomain?: string | null }): { visit: string; deployment: string | null } {
  const deployment = d.url ? `https://${d.url}` : null;
  if (!d.primaryDomain) return { visit: deployment ?? "", deployment: null };
  return { visit: `https://${d.primaryDomain}`, deployment };
}

export function DeployRowActions({ d, actions, logs, changes = false, explain = false }: DeployRowProps) {
  const mask = useMask();
  const { open, dialog } = useProviderAction();
  const [logsOpen, setLogsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const sha = d.sha ? d.sha.slice(0, 7) : "";
  const { visit, deployment } = visitLinks(d);
  const { buttons, menu } = rowLayout({ actions, logs, changes, visit: !!visit && d.visit });
  const confirm = (a: DeployActionLabel) => open({ ...confirmCopy(a, mask("app", d.appName), sha), run: runFor(a, d.appId, d.externalId) });
  const entry = (i: RowItem): MenuEntry => (i.kind === "visit" ? { label: i.label, href: visit }
    : i.kind === "logs" ? { label: i.label, onSelect: () => setLogsOpen(true) }
      : i.kind === "changes" ? { label: i.label, onSelect: () => setChangesOpen(true) }
        : { label: i.label, onSelect: () => confirm(i.action!) });

  return (
    <div className="flex items-center gap-1.5">
      {buttons.map((i) => (i.kind === "visit"
        ? <a key={i.label} href={visit} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm" })}>Visit</a>
        : i.kind === "logs"
          ? <Button key={i.label} size="sm" onClick={() => setLogsOpen(true)}>{i.label}</Button>
          : <Button key={i.label} size="sm" onClick={() => confirm(i.action!)}>{i.label}</Button>))}
      {deployment && d.visit && logs !== "button" && (
        <a href={deployment} target="_blank" rel="noreferrer" className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline">Deployment URL</a>
      )}
      {menu.length > 0 && <RowMenu label={actionsLabel(mask("app", d.appName), sha || d.url || d.externalId)} items={menu.map(entry)} />}
      {dialog}
      {logs && <BuildLogsDrawer appId={d.appId} deploymentId={d.externalId} title={`${mask("app", d.appName)}${sha ? ` ${sha}` : ""}`} open={logsOpen} onOpenChange={setLogsOpen} explain={explain} />}
      {changes && <ReleaseNotesDrawer appId={d.appId} deploymentId={d.externalId} title={`${mask("app", d.appName)}${sha ? ` ${sha}` : ""}`} open={changesOpen} onOpenChange={setChangesOpen} />}
    </div>
  );
}
