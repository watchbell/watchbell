import { CopyButton } from "@/components/copy-button";
import { Card } from "@/components/kit";
import { Status } from "@/components/status";
import { DEPS_COPY } from "@/lib/copy/edition";
import { readActionsRepo } from "@/lib/data/actions-lockfile-db";
import { WORKFLOW_YAML } from "@/lib/deps/actions-lockfile";
import { ActionsRepoForm } from "./actions-repo-form";

const code = "block overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[12.5px] whitespace-pre";

// Settings › Lockfile via GitHub Actions (owner 16 Oct): update PRs get their package-lock.json from a workflow run in
// the owner's own small actions repository (lib/data/deps-pr.ts dispatches it). Core: the Settings page shows it as its
// own tab, unless the private edition's Runner tab (registry r1) shows it beside the VM runner.
export async function ActionsLockfileCard() {
  const actionsRepo = await readActionsRepo().catch(() => null);
  return (
    <Card title="Lockfile via GitHub Actions" meta={actionsRepo ? <Status state="ok">On</Status> : <Status state="off">Off</Status>}>
      <p className="text-[13px] text-ink-soft">{DEPS_COPY.lockfileIntro}</p>
      <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5 text-[13px]">
        <li>Create a repository on GitHub, for example <span className="font-mono">watchbell-actions</span> (private is fine).</li>
        <li>Add the file <span className="font-mono">.github/workflows/watchbell-lockfile.yml</span> <CopyButton text=".github/workflows/watchbell-lockfile.yml" label="Copy path" /> with this content:
          <div className="mt-1 flex justify-end"><CopyButton text={WORKFLOW_YAML} label="Copy workflow" /></div>
          <code className={`${code} mt-1 max-h-72`}>{WORKFLOW_YAML}</code>
        </li>
        <li>In that repository: Settings › Secrets and variables › Actions › New repository secret, name <span className="font-mono">WATCHBELL_PR_TOKEN</span> <CopyButton text="WATCHBELL_PR_TOKEN" label="Copy name" />, value: your GitHub PR-write token (the same one on Connections).</li>
        <li>Give the PR-write token access to this new repository too (GitHub › Settings › Developer settings › your token › Repository access), with Contents: Read and write.</li>
        <li>Save the repository name here:</li>
      </ol>
      <div className="mt-2"><ActionsRepoForm current={actionsRepo} /></div>
    </Card>
  );
}
