"use client";

import { useEffect, useState } from "react";
import { MaskedText } from "@/components/alias";
import { useHoldRefresh } from "@/components/live";
import { Src } from "@/components/sources";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import type { Commit } from "@/lib/providers/github-browse";
import { rel } from "@/lib/view/format";
import { prNumber, type ReleaseNotes } from "@/lib/view/release-notes";
import { releaseNotesAction } from "../vercel-actions";

const COMMIT_URL = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/commit\/[0-9a-f]+$/;
const link = "text-brand underline-offset-2 hover:underline";

// "#12" opens the pull request on the commit's own repository (the URL is GitHub's, checked by the provider).
function prLink(c: Commit, n: number): string | null {
  const m = c.url ? COMMIT_URL.exec(c.url) : null;
  return m ? `${m[1]}/pull/${n}` : null;
}

function CommitRow({ c, now }: { c: Commit; now: Date }) {
  const pr = prNumber(c.title);
  const prHref = pr === null ? null : prLink(c, pr);
  const sha = c.sha.slice(0, 7);
  return (
    <li className="border-b border-line px-[18px] py-2.5 last:border-b-0">
      <div className="text-[13px] [overflow-wrap:anywhere]">
        <MaskedText text={c.title} />
        {prHref && <> <a href={prHref} target="_blank" rel="noreferrer" className={link}>#{pr}</a></>}
      </div>
      <div className="mt-0.5 font-mono text-xs text-ink-faint">
        {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className={link}>{sha}</a> : sha}
        {c.author && <> · <MaskedText text={c.author} /></>}
        {c.at && <> · {rel(new Date(c.at), now)}</>}
      </div>
    </li>
  );
}

// The list itself, newest first. Pure (tested with renderToStaticMarkup).
export function ReleaseNotesBody({ notes, now }: { notes: ReleaseNotes; now: Date }) {
  if (notes.note) return <p className="px-[18px] pb-4 text-[13px] text-ink-soft">{notes.note}</p>;
  if (notes.commits.length === 0) return <p className="px-[18px] pb-4 text-[13px] text-ink-soft">GitHub found no commits between these deployments.</p>;
  const more = notes.total - notes.commits.length;
  return (
    <>
      <p className="px-[18px] pb-2 text-[12.5px] text-ink-soft">
        {notes.total} commit{notes.total === 1 ? "" : "s"}{notes.from ? <> since <span className="font-mono">{notes.from.slice(0, 7)}</span></> : null}
      </p>
      <ul className="min-h-0 flex-1 overflow-auto border-t border-line">
        {notes.commits.map((c) => <CommitRow key={c.sha} c={c} now={now} />)}
        {notes.cut && more > 0 && <li className="px-[18px] py-2.5 text-[12.5px] text-ink-soft">+{more} more, older, not shown</li>}
      </ul>
    </>
  );
}

// Deployments → What changed (1.3): the commits since the previous production deployment, read from GitHub when the
// drawer opens (Operator+). Nothing is kept after it closes.
export function ReleaseNotesDrawer({ appId, deploymentId, title, open, onOpenChange, read = releaseNotesAction }: {
  appId: string; deploymentId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void;
  read?: (appId: string, deploymentId: string) => Promise<ActionResult<ReleaseNotes>>;
}) {
  const [state, setState] = useState<{ notes: ReleaseNotes; at: Date } | { error: string } | null>(null);
  useHoldRefresh(open);
  useEffect(() => {
    if (!open) return;
    let live = true;
    read(appId, deploymentId)
      .then((r) => { if (live) setState(r.ok && r.data ? { notes: r.data, at: new Date() } : { error: r.ok ? "Nothing came back." : r.error }); })
      .catch(() => { if (live) setState({ error: "Watchbell didn't answer. Check that it's still running, then try again." }); });
    return () => { live = false; setState(null); };
  }, [open, appId, deploymentId, read]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto flex h-dvh max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-[620px]">
        <div className="px-[18px] pb-2 pt-4 pr-12">
          <DialogTitle className="text-base">What changed · {title}</DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px] text-ink-soft">Since the previous production deployment, compared on GitHub now<Src kind="api" /></DialogDescription>
        </div>
        {state === null ? <p className="px-[18px] pb-4 text-[13px] text-ink-soft">Reading the commits…</p>
          : "error" in state ? <p role="alert" className="px-[18px] pb-4 text-[13px] text-err">{state.error}</p>
            : <ReleaseNotesBody notes={state.notes} now={state.at} />}
      </DialogContent>
    </Dialog>
  );
}
