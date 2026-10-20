"use client";

import { useMask } from "@/components/alias";
import { Button, buttonClass, LaterButton } from "@/components/kit";
import { useProviderAction } from "@/components/provider-action";
import { type MenuEntry, RowMenu } from "@/components/row-menu";
import type { ActionResult } from "@/lib/action";
import { confirmCopy, type DeployActionLabel } from "@/lib/view/deploy-actions";
import { actionsLabel } from "@/lib/view/labels";
import { cancelAction, promoteAction, promotePreviewAction, redeployAction, rollbackAction } from "../vercel-actions";

// Stage 6: a deployment row's actions, as the mockup's depRow() and actions() decide them. Visit is a link and View
// build logs (building, failed) stays disabled until it arrives; the Vercel actions open the confirm dialog (A3) and
// call the server action with the ids this row showed. Up to two show as buttons, more go in the row's menu.
export type DeployRowProps = {
  // `visit` is false in demo, where the deployment url is made up: no Visit link.
  d: { appId: string; appName: string; externalId: string; sha: string | null; url: string | null; visit: boolean };
  actions: DeployActionLabel[];
  logs: boolean;
};

const LOGS_STAGE = 5;

function runFor(label: DeployActionLabel, appId: string, id: string): () => Promise<ActionResult> {
  switch (label) {
    case "Redeploy": return () => redeployAction(appId, id);
    case "Roll back to this": return () => rollbackAction(appId, id);
    case "Promote": return () => promoteAction(appId, id);
    case "Cancel": return () => cancelAction(appId, id);
    case "Promote to production": return () => promotePreviewAction(appId, id);
  }
}

type Item = { label: string; kind: "visit" | "logs" | "action"; action?: DeployActionLabel };

export function DeployRowActions({ d, actions, logs }: DeployRowProps) {
  const mask = useMask();
  const { open, dialog } = useProviderAction();
  const sha = d.sha ? d.sha.slice(0, 7) : "";
  const visit = d.url ? `https://${d.url}` : "";
  const items: Item[] = [
    ...(d.url && d.visit && !logs ? [{ label: "Visit", kind: "visit" as const }] : []),
    ...actions.map((a) => ({ label: a, kind: "action" as const, action: a })),
    ...(logs ? [{ label: "View build logs", kind: "logs" as const }] : []),
  ];
  const confirm = (a: DeployActionLabel) => open({ ...confirmCopy(a, mask("app", d.appName), sha), run: runFor(a, d.appId, d.externalId) });

  if (items.length > 2) {
    const entries: MenuEntry[] = items.map((i) => (i.kind === "visit" ? { label: i.label, href: visit }
      : i.kind === "logs" ? { label: i.label, later: LOGS_STAGE }
      : { label: i.label, onSelect: () => confirm(i.action!) }));
    return <><RowMenu label={actionsLabel(mask("app", d.appName), sha || d.url || d.externalId)} items={entries} />{dialog}</>;
  }
  return (
    <div className="flex gap-1.5">
      {items.map((i) => (i.kind === "visit"
        ? <a key={i.label} href={visit} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm" })}>Visit</a>
        : i.kind === "logs"
          ? <LaterButton key={i.label} label={i.label} stage={LOGS_STAGE} />
          : <Button key={i.label} size="sm" onClick={() => confirm(i.action!)}>{i.label}</Button>))}
      {dialog}
    </div>
  );
}
