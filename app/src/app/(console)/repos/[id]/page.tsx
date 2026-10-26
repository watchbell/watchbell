import { IconExternalLink } from "@tabler/icons-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Masked } from "@/components/alias";
import { ExternalLink } from "@/components/external-link";
import { Banner, Card, EmptyState, PageHeader } from "@/components/kit";
import { PlainTable } from "@/components/plain-table";
import { Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { outboundLinks } from "@/lib/demo/links";
import { HIDDEN_TEXT } from "@/lib/code/never-read";
import { redactCode } from "@/lib/code/redact";
import { branchesOf, commitsOf, fileOf, readmeOf, repoDepsView, type RepoHead, repoHead, repoInfoOf, runsOf, treeOf } from "@/lib/data/repos-db";
import { ancestors, buildTree, FILE_VIEW_MAX, filePlan, sizeText } from "@/lib/github/browse";
import { parseMarkdown } from "@/lib/github/markdown";
import { isRateLimit } from "@/lib/github/ttl-cache";
import type { Failure } from "@/lib/providers/http";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { shortSha } from "@/lib/view/format";
import { actionsStatus } from "@/lib/view/github";
import { hideEmails } from "@/lib/view/display-name";
import { DependenciesCard } from "../../apps/[id]/deps-card";
import { VisibilityTag } from "../repo-list";
import { FileTree } from "./file-tree";
import { Markdown } from "./markdown";

// GitHub → Repositories → one repository (owner 16 Oct), read-only. Each tab reads only what it shows (GET, cached a
// few minutes in memory, lib/data/repos-db.ts), so a page view costs GitHub one or two calls. Files the console never
// reads (lib/code/never-read.ts: env, keys, certificates, lockfiles, build output, binaries) are listed as hidden and
// never fetched; every shown text (README, file) also goes through the secret redaction first.

export const maxDuration = 30;

const TABS = [["readme", "README"], ["files", "Files"], ["commits", "Commits"], ["branches", "Branches"], ["actions", "Actions"], ["deps", "Dependencies"]] as const;
type Tab = (typeof TABS)[number][0];

const KV = "grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";
const mono = "font-mono text-[12.5px]";
const ext = <IconExternalLink size={13} aria-hidden className="inline align-[-2px]" />;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Problem({ f }: { f: Failure }) {
  return isRateLimit(f)
    ? <Banner tone="warning" title="Rate limited, try later.">GitHub&apos;s rate limit for the token is used up. Cached pages still show; the rest come back when it resets.</Banner>
    : <Banner tone="danger" title="GitHub couldn't be read.">{f.error}</Banner>;
}

export default async function RepoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const member = await requirePageMember();
  const head = await repoHead(id);
  if (!head) notFound();
  const now = new Date();
  const tabArg = one(sp.tab);
  const tab: Tab = TABS.some(([k]) => k === tabArg) ? (tabArg as Tab) : "readme";
  const { repo, apps } = head;
  const gh = repo.htmlUrl?.startsWith("https://github.com/") ? repo.htmlUrl : `https://github.com/${repo.fullName}`;
  const info = await repoInfoOf(head);
  const run = repo.actions ? actionsStatus(repo.actions, repo.defaultBranch) : null;
  // The VM runner's preview (private edition, registry r1), owner only.
  const Preview = extensions.RepoPreviewSlot;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "DevOps" }, { label: "Repositories", href: "/repos" }, { label: repo.name }]}
        title={<span className="font-mono text-[20px]"><Masked kind="repo" real={repo.fullName} /></span>}
        actions={outboundLinks() && <a href={gh} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink hover:bg-hover">Open on GitHub {ext}</a>}
      />
      <div className="mt-4 flex flex-col gap-4">
        {repo.goneAt && <Banner tone="warning" title="This repository is no longer shared with the GitHub token.">The details below are from the last sync.</Banner>}
        {!info.ok && !repo.goneAt && <Problem f={info} />}
        <Card title="Repository" meta={<Src kind="api">GitHub</Src>}>
          <dl className={KV}>
            <dt>Visibility</dt><dd><VisibilityTag isPrivate={repo.private} archived={repo.archived} /></dd>
            {info.ok && info.data.description && <><dt>Description</dt><dd>{hideEmails(info.data.description)}</dd></>}
            <dt>Linked apps</dt>
            <dd>{apps.length ? <span className="flex flex-wrap gap-x-4 gap-y-1">{apps.map((a) => <Resource key={a.id} kind="app" name={a.name} href={`/apps/${a.id}`} />)}</span> : <span className="text-ink-faint">None. An owner links a repository on the app&apos;s page.</span>}</dd>
            <dt>Default branch</dt><dd className={mono}>{repo.defaultBranch ?? "—"}</dd>
            <dt>Last push</dt><dd>{repo.pushedAt ? ago(repo.pushedAt, now) : "—"}</dd>
            {info.ok && info.data.language && <><dt>Language</dt><dd>{info.data.language}</dd></>}
            <dt>Open</dt>
            <dd>
              {info.ok ? (
                <span className="flex flex-wrap gap-x-4">
                  <ExternalLink href={`${gh}/pulls`} target="_blank" rel="noopener noreferrer"><span className={mono}>{info.data.openPulls}</span> pull request{info.data.openPulls === 1 ? "" : "s"} {outboundLinks() && ext}</ExternalLink>
                  <ExternalLink href={`${gh}/issues`} target="_blank" rel="noopener noreferrer"><span className={mono}>{Math.max(0, info.data.openIssuesAndPulls - info.data.openPulls)}</span> issue{info.data.openIssuesAndPulls - info.data.openPulls === 1 ? "" : "s"} {outboundLinks() && ext}</ExternalLink>
                </span>
              ) : <span className="text-ink-faint">—</span>}
            </dd>
            {run && <><dt>Latest Actions</dt><dd><Status state={run.state}>{run.label}</Status>{repo.actionsCheckedAt && <span className="text-ink-faint"> · read {ago(repo.actionsCheckedAt, now)}</span>}</dd></>}
          </dl>
        </Card>

        {Preview && member.role === "owner" && !repo.goneAt && <Preview repoId={repo.id} />}

        <nav aria-label="Repository sections" className="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--oc-line)]">
          {TABS.map(([k, label]) => (
            <Link key={k} href={`/repos/${repo.id}?tab=${k}`} aria-current={tab === k ? "page" : undefined} scroll={false}
              className={cn("relative whitespace-nowrap px-3 py-2 text-sm text-ink-soft hover:text-ink", tab === k && "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-brand")}>
              {label}
            </Link>
          ))}
        </nav>

        {tab === "readme" && <ReadmeTab head={head} />}
        {tab === "files" && <FilesTab head={head} file={one(sp.file) ?? null} />}
        {tab === "commits" && <CommitsTab head={head} now={now} />}
        {tab === "branches" && <BranchesTab head={head} gh={gh} />}
        {tab === "actions" && <ActionsTab head={head} now={now} />}
        {tab === "deps" && <DependenciesCard app={{ id: repo.id, name: repo.name }} view={await repoDepsView(repo)} canAct={false} owner={false} now={now} />}
      </div>
    </>
  );
}

async function ReadmeTab({ head }: { head: RepoHead }) {
  const r = await readmeOf(head);
  if (!r.ok) return <Problem f={r} />;
  if (!r.data) return <Card><EmptyState title="No README">This repository has no README on {head.ref}.</EmptyState></Card>;
  const { path, text, size } = r.data;
  if (text === null) return <Card title={path}><p className="text-ink-soft">The README is {sizeText(size)}; over {sizeText(FILE_VIEW_MAX)} it isn&apos;t shown here.</p></Card>;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const tree = parseMarkdown(redactCode(text), { fullName: head.repo.fullName, ref: head.ref, dir, isPrivate: head.repo.private });
  return <Card title={<span className={mono}>{path}</span>}><Markdown tree={tree} /></Card>;
}

async function FilesTab({ head, file }: { head: RepoHead; file: string | null }) {
  const t = await treeOf(head);
  if (!t.ok) return <Problem f={t} />;
  const { root, files, cut } = buildTree(t.data.entries);
  const href = (path: string) => `/repos/${head.repo.id}?tab=files&file=${encodeURIComponent(path)}`;
  return (
    <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <Card title="Files" meta={<span className={mono}>{head.ref}</span>}>
        {files === 0 && !root.children.length ? <p className="text-ink-soft">This repository has no files on {head.ref}.</p> : (
          <div className="max-h-[70vh] overflow-auto">
            <FileTree root={root} href={href} open={file ? ancestors(file) : []} current={file} />
          </div>
        )}
        {(cut || t.data.truncated) && <p className="mt-2 text-[12.5px] text-ink-faint">The repository is large; only part of its tree is listed.</p>}
      </Card>
      {file ? <FileView head={head} path={file} entries={t.data.entries} /> : <Card><EmptyState title="Pick a file">Choose a file in the tree to read it here.</EmptyState></Card>}
    </div>
  );
}

async function FileView({ head, path, entries }: { head: RepoHead; path: string; entries: { path: string; size: number }[] }) {
  const plan = filePlan(path, entries);
  const title = <span className={cn(mono, "break-all")}>{plan.kind === "missing" ? "Not found" : path}</span>;
  const onGh = plan.kind === "missing" || (plan.kind === "hidden" && plan.reason === "secret") ? null
    : `https://github.com/${head.repo.fullName}/blob/${encodeURIComponent(head.ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const meta = onGh && outboundLinks() ? <a href={onGh} target="_blank" rel="noopener noreferrer">GitHub {ext}</a> : undefined;
  let body: ReactNode;
  if (plan.kind === "missing") body = <p className="text-ink-soft">That file isn&apos;t in the repository&apos;s tree on {head.ref}.</p>;
  else if (plan.kind === "hidden") body = <p className="text-ink-soft">This file is {HIDDEN_TEXT[plan.reason]}. Watchbell never reads it.</p>;
  else if (plan.kind === "too-big") body = <p className="text-ink-soft">This file is {sizeText(plan.size)}; over {sizeText(FILE_VIEW_MAX)} it isn&apos;t shown here.</p>;
  else {
    const r = await fileOf(head, path);
    if (!r.ok) return <Problem f={r} />;
    if (r.data === null) body = <p className="text-ink-soft">This file is binary or too large to show.</p>;
    else {
      const lines = redactCode(r.data).split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      body = (
        <div className="-mx-[18px] -mb-4 overflow-x-auto border-t border-line">
          <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.55]">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="w-px select-none whitespace-nowrap border-r border-line bg-surface-2 px-3 text-right align-top text-ink-faint">{i + 1}</td>
                  <td className="whitespace-pre px-3">{l || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
  return <Card title={title} meta={meta}>{body}</Card>;
}

async function CommitsTab({ head, now }: { head: RepoHead; now: Date }) {
  const r = await commitsOf(head);
  if (!r.ok) return <Problem f={r} />;
  return (
    <Card title="Recent commits" meta={<span className={mono}>{head.ref}</span>} flush>
      {r.data.length === 0 ? <EmptyState title="No commits">Nothing on {head.ref} yet.</EmptyState> : (
        <PlainTable head={["Commit", "Message", "Author", "When"]} rows={r.data.map((c) => ({
          key: c.sha, state: "", text: c.title,
          row: (
            <tr className={rowClass}>
              <td className={cn(td, mono)}>{c.url ? <ExternalLink href={c.url} target="_blank" rel="noopener noreferrer">{shortSha(c.sha)}</ExternalLink> : shortSha(c.sha)}</td>
              <td className={cn(td, tdWrap)}>{hideEmails(c.title)}</td>
              <td className={cn(td, "text-ink-soft")}>{c.author ? hideEmails(c.author) : "—"}</td>
              <td className={td}>{c.at ? ago(new Date(c.at), now) : "—"}</td>
            </tr>
          ),
        }))} />
      )}
    </Card>
  );
}

async function BranchesTab({ head, gh }: { head: RepoHead; gh: string }) {
  const r = await branchesOf(head);
  if (!r.ok) return <Problem f={r} />;
  const list = [...r.data.branches].sort((a, b) => (a.name === head.repo.defaultBranch ? -1 : b.name === head.repo.defaultBranch ? 1 : a.name.localeCompare(b.name)));
  return (
    <Card title="Branches" meta={outboundLinks() ? <a href={`${gh}/branches`} target="_blank" rel="noopener noreferrer">All on GitHub {ext}</a> : undefined} flush>
      <PlainTable head={["Branch", "Head", ""]} rows={list.map((b) => ({
        key: b.name, state: "", text: b.name,
        row: (
          <tr className={rowClass}>
            <td className={cn(td, mono)}><ExternalLink href={`${gh}/tree/${b.name.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noopener noreferrer">{b.name}</ExternalLink></td>
            <td className={cn(td, mono, "text-ink-soft")}>{shortSha(b.sha)}</td>
            <td className={cn(td, "text-ink-soft")}>{[b.name === head.repo.defaultBranch ? "default" : null, b.protected ? "protected" : null].filter(Boolean).join(" · ")}</td>
          </tr>
        ),
      }))} />
      {r.data.more && <p className="px-[18px] py-2 text-[12.5px] text-ink-faint">The first 100 branches are listed.</p>}
    </Card>
  );
}

async function ActionsTab({ head, now }: { head: RepoHead; now: Date }) {
  const r = await runsOf(head);
  if (!r.ok) return <Problem f={r} />;
  return (
    <Card title="GitHub Actions" meta={<span>last 10 runs</span>} flush>
      {r.data.length === 0 ? <EmptyState title="No workflow runs">This repository has no GitHub Actions runs.</EmptyState> : (
        <PlainTable head={["Status", "Workflow", "Branch", "Commit", "When"]} rows={r.data.map((x) => {
          const s = actionsStatus({ status: x.status, conclusion: x.conclusion, name: x.name, branch: x.branch, sha: x.sha, url: x.url, at: x.at, runNumber: x.runNumber }, null);
          return {
            key: String(x.id), state: s.state, text: `${x.name ?? ""} ${x.title ?? ""}`,
            row: (
              <tr className={rowClass}>
                <td className={td}><Status state={s.state}>{s.label}</Status></td>
                <td className={cn(td, tdWrap)}>
                  {x.url ? <ExternalLink href={x.url} target="_blank" rel="noopener noreferrer">{x.name ?? "workflow"}{x.runNumber ? ` #${x.runNumber}` : ""}</ExternalLink> : x.name ?? "workflow"}
                  {x.title && <div className="mt-0.5 text-ink-soft">{hideEmails(x.title)}</div>}
                </td>
                <td className={cn(td, mono)}>{x.branch ?? "—"}{x.event && <span className="ml-1.5 font-sans text-xs text-ink-faint">{x.event}</span>}</td>
                <td className={cn(td, mono, "text-ink-soft")}>{shortSha(x.sha)}</td>
                <td className={td}>{x.at ? ago(new Date(x.at), now) : "—"}</td>
              </tr>
            ),
          };
        })} />
      )}
    </Card>
  );
}
