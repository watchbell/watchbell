"use client";

import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, Card } from "@/components/kit";
import { StateIcon } from "@/components/status";
import type { GeneratedFiles } from "@/lib/data/buildfiles-db";
import type { BuildFilesPr } from "@/lib/data/buildfiles-pr";
import { cn } from "@/lib/utils";
import { buildFilesAction, buildFilesPrAction } from "./buildfiles-actions";

// Details → Build files (Watchbell 1.5): a Dockerfile, .dockerignore, docker-compose.yml, a CI workflow and a Kubernetes
// manifest written from the app's settings. Only when asked; nothing is built, deployed or stored. The owner can put
// them on a new branch as a pull request; files the repository already has are never overwritten.

const KIND: Record<GeneratedFiles["facts"]["kind"], string> = { nextjs: "Next.js", vite: "Vite", cra: "Create React App", node: "Node" };

export const guessedNote = (guessed: string[]): string | null =>
  guessed.length ? `Guessed: ${guessed.join(", ")}. Check them before using the files.` : null;

export const fileLabel = (path: string): string => path.split("/").pop() ?? path;

// Under the Open pull request button; in the demo the button is off (M10).
export const prHint = (demo: boolean, repo: string): string =>
  demo ? "Pull requests are off in the demo." : `On a new branch of ${repo}; files it already has are never overwritten.`;

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dt]:text-ink-soft";
const UNREACHABLE = "Watchbell didn't answer. Check that it's still running, then try again.";

export function BuildFilesCard({ appId, owner, demo = false }: { appId: string; owner: boolean; demo?: boolean }) {
  const [gen, setGen] = useState<GeneratedFiles | null>(null);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState<BuildFilesPr | null>(null);
  const [pending, start] = useTransition();
  const [opening, startPr] = useTransition();

  const generate = () => start(async () => {
    try {
      const r = await buildFilesAction(appId);
      if (r.ok && r.data) { setGen(r.data); setTab(0); setError(null); setPr(null); } else setError(r.ok ? "No answer." : r.error);
    } catch {
      setError(UNREACHABLE);
    }
  });
  const openPr = () => startPr(async () => {
    try {
      const r = await buildFilesPrAction(appId);
      if (r.ok && r.data) { setPr(r.data); setError(null); } else setError(r.ok ? "No answer." : r.error);
    } catch {
      setError(UNREACHABLE);
    }
  });

  const file = gen?.files[tab] ?? null;
  const guessed = gen ? guessedNote(gen.facts.guessed) : null;
  return (
    <Card title="Build files" meta={<Button size="sm" onClick={generate} disabled={pending}>{pending ? "Generating…" : gen ? "Generate again" : "Generate"}</Button>} flush>
      <div className="px-[18px] pb-4 pt-2">
        {error && <p className="mb-2 flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>{error}</span></p>}
        {!gen ? (
          <p className="text-ink-soft">Not generated yet. Generate writes a Dockerfile, docker-compose.yml, a GitHub Actions CI workflow and a Kubernetes manifest from this app&apos;s settings. Env names only, never values; nothing is built or deployed.</p>
        ) : (
          <>
            <dl className={KV}>
              <dt>Framework</dt>
              <dd>{KIND[gen.facts.kind]}{gen.facts.kind === "nextjs" ? (gen.facts.standalone ? " (standalone output)" : "") : ""}</dd>
              <dt>Package manager, Node</dt>
              <dd>{gen.facts.pm}, Node {gen.facts.node}</dd>
              <dt>Folder</dt>
              <dd className="font-mono text-[12.5px]">{gen.facts.dir}</dd>
              <dt>Env names</dt>
              <dd>{gen.facts.envNames.length}</dd>
            </dl>
            {guessed && <p className="mt-2 flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>{guessed}</span></p>}
            <div role="tablist" aria-label="Build files" className="mt-3 inline-flex flex-wrap overflow-hidden rounded-md border border-line-strong">
              {gen.files.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  role="tab"
                  aria-selected={tab === i}
                  onClick={() => setTab(i)}
                  className={cn("px-2.5 py-1 text-[13px] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40", tab === i ? "bg-brand-soft font-medium text-brand" : "bg-surface text-ink-soft")}
                >
                  {fileLabel(f.path)}
                </button>
              ))}
            </div>
            {file && (
              <div className="mt-2">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-ink-soft">{file.path}</span>
                  <CopyButton text={file.text} />
                </div>
                {file.note && <p className="mb-1.5 text-[12.5px] text-ink-soft">{file.note}</p>}
                <pre className="max-h-[360px] overflow-auto rounded-md bg-code-bg p-3 font-mono text-[12px] leading-relaxed text-code-text">{file.text}</pre>
              </div>
            )}
            {owner && gen.repo && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={openPr} disabled={demo || opening || !!pr}>{opening ? "Opening…" : "Open pull request"}</Button>
                {pr ? (
                  <span>
                    <a href={pr.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">Pull request #{pr.number}</a> opened
                    {pr.skipped.length ? <span className="text-ink-soft"> · left alone (already there): {pr.skipped.map(fileLabel).join(", ")}</span> : null}
                  </span>
                ) : (
                  <span className="text-[12.5px] text-ink-soft">{prHint(demo, gen.repo)}</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
