import { IconGitBranch } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Tag } from "@/components/kit";
import { Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td, tdWrap } from "@/components/table";
import type { DeploymentRow } from "@/lib/data/deployments-db";
import { cn } from "@/lib/utils";
import { commitTitle, createdText, deployDuration, shortSha } from "@/lib/view/format";
import { actionsFor, rowRoles } from "@/lib/view/deploy-actions";
import { deploymentStatus } from "@/lib/view/labels";
import { MaskedText } from "@/components/alias";
import { outboundLinks } from "@/lib/demo/links";
import { offersChanges } from "@/lib/view/release-notes";
import { DeployRowActions } from "./deploy-row-actions";

export const DEPLOY_HEAD: ReactNode[] = [
  "Status", "Project", "Environment",
  // The commit message is confirmed from Vercel's API (spec §14, 12 Oct), so no "needs test" tag (1.2.1).
  <span key="commit">Commit and branch<Src kind="api" /></span>,
  <span key="dur">Duration<Src kind="calc" /></span>,
  "Created", "",
];

// Stage 6: each row's Vercel actions come from its role among its app's rows (current, previous, staged, building…),
// as the mockup's depRow() lists them. Viewers get no action controls (so no build logs either: Operator+, Task 4).
// `explain` (1.3): the member is the owner and the AI extension is there, so a failed build's log offers Explain with AI.
export function deploymentRows(list: DeploymentRow[], o: { canAct: boolean; explain?: boolean; now: Date }): ListRow[] {
  const roles = rowRoles(list);
  // A9: apps with a staged deployment are rolled back, so their current row offers Promote's way out, not Redeploy.
  const rolledBack = new Set(list.filter((d) => roles.get(d.externalId) === "staged").map((d) => d.appId));
  return list.map((d) => {
    const role = roles.get(d.externalId) ?? "other";
    const s = deploymentStatus(d.state);
    const env = d.target === "production" ? "Production" : "Preview";
    return {
      key: d.id,
      state: s.state,
      text: [s.label, d.appName, env, shortSha(d.commitSha), commitTitle(d.commitMessage), d.branch ?? ""].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}><Status state={s.state}>{s.label}</Status>{d.isCurrent && <> <Tag>Current</Tag></>}</td>
          <td className={td}><Resource kind="app" name={d.appName} href={`/apps/${d.appId}`} /></td>
          <td className={td}><Tag>{env}</Tag></td>
          <td className={cn(td, tdWrap)}>
            <span className="font-mono text-[12.5px]">{shortSha(d.commitSha)}</span> <span className="text-ink-soft"><MaskedText text={commitTitle(d.commitMessage)} /></span>
            <div className="mt-0.5 font-mono text-xs text-ink-faint"><IconGitBranch size={13} aria-hidden className="inline align-[-2px]" /> {d.branch ?? "—"}</div>
          </td>
          <td className={cn(td, "font-mono text-[12.5px]")}>{deployDuration(d, o.now)}</td>
          <td className={cn(td, "text-ink-soft")}>{createdText(d.createdAt, o.now)}</td>
          <td className={td}>
            {o.canAct && (
              <DeployRowActions
                d={{ appId: d.appId, appName: d.appName, externalId: d.externalId, sha: d.commitSha, url: d.url, visit: outboundLinks(), primaryDomain: d.primaryDomain }}
                actions={actionsFor(role, rolledBack.has(d.appId))}
                logs={role === "building" || role === "failed" ? "button" : d.state === "ready" ? "menu" : null}
                changes={offersChanges(d)}
                explain={!!o.explain && d.state === "error"}
              />
            )}
          </td>
        </tr>
      ),
    };
  });
}
