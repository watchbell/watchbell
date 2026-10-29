"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/kit";
import { Src } from "@/components/sources";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useHoldRefresh } from "@/components/live";
import type { ActionResult } from "@/lib/action";
import { type BuildLog, firstErrorIndex, isErrorLine, MAX_BUILD_LINES } from "@/lib/view/build-logs";
import { cn } from "@/lib/utils";
import { buildLogsAction, explainBuildAction } from "../vercel-actions";

const TONE = { stdout: "", stderr: "text-code-warn", command: "text-code-info", delimiter: "text-code-dim" } as const;
export const lineId = (i: number) => `build-line-${i}`;

// The log itself: error lines highlighted, "Jump to first error" when there is one. Pure (tested with
// renderToStaticMarkup); the jump scrolls the first error line into view.
export function BuildLogBody({ log }: { log: BuildLog }) {
  const first = firstErrorIndex(log.lines);
  const errors = log.lines.filter(isErrorLine).length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-[18px] pb-2 text-[12.5px] text-ink-soft">
        <span>{log.lines.length} lines{log.truncated ? ` (the last ${MAX_BUILD_LINES.toLocaleString("en-US")})` : ""}</span>
        {first >= 0 ? (
          <>
            <span className="text-err">{errors} error line{errors === 1 ? "" : "s"}</span>
            {/* A button, not an #anchor: no history entry or hash on the page (review T4c minor 6a). */}
            <button type="button" data-line={lineId(first)} className="text-brand hover:underline"
              onClick={() => document.getElementById(lineId(first))?.scrollIntoView({ block: "center" })}>Jump to first error</button>
          </>
        ) : <span>No error lines</span>}
      </div>
      <div tabIndex={0} aria-label="Build log lines" className="min-h-0 flex-1 overflow-auto bg-code-bg px-4 py-3 font-mono text-[12.5px] leading-[1.7] text-code-text">
        {log.lines.length === 0 ? <div className="text-code-dim">Vercel returned no build output for this deployment.</div> : log.lines.map((l, i) => {
          const err = isErrorLine(l);
          return (
            <div key={i} id={lineId(i)} data-error={err ? "" : undefined}
              className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", err ? "-mx-4 border-l-2 border-err bg-err/15 px-[14px] text-code-err" : TONE[l.kind], l.kind === "delimiter" && "mt-1.5 font-medium")}>
              {l.kind === "command" ? `$ ${l.text}` : l.text || " "}
            </div>
          );
        })}
      </div>
    </>
  );
}

type Explained = { text: string; model: string };
export type ExplainState = "asking" | Explained | { error: string };

// Explain with AI's answer above the log (1.3). Pure (tested with renderToStaticMarkup).
export function Explanation({ answer }: { answer: ExplainState }) {
  if (answer === "asking") return <p className="px-[18px] pb-3 text-[13px] text-ink-soft">Asking the AI provider…</p>;
  if ("error" in answer) return <p role="alert" className="px-[18px] pb-3 text-[13px] text-err">{answer.error}</p>;
  return (
    <section aria-label="Explanation" className="mx-[18px] mb-3 rounded-lg border border-line px-3.5 py-2.5">
      <div className="flex items-baseline gap-2 text-[12.5px]">
        <b className="font-medium">Explanation</b>
        <span className="font-mono text-xs text-ink-faint">{answer.model}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">{answer.text}</p>
      <p className="mt-1.5 text-xs text-ink-faint">Written by a model from the log below. Check it against the log before you change code.</p>
    </section>
  );
}

// Deployments → View build logs: a side drawer that reads the build log when it opens (Operator+; the server reads
// Vercel with the stored token). Nothing is kept after it closes. `explain` (1.3, owner, a failed build): an Explain
// with AI button, one provider call per click.
export function BuildLogsDrawer({ appId, deploymentId, title, open, onOpenChange, explain = false, read = buildLogsAction, ask = explainBuildAction }: {
  appId: string; deploymentId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void; explain?: boolean;
  read?: (appId: string, deploymentId: string) => Promise<ActionResult<BuildLog>>;
  ask?: (appId: string, deploymentId: string) => Promise<ActionResult<Explained>>;
}) {
  const [state, setState] = useState<{ log: BuildLog } | { error: string } | null>(null);
  const [answer, setAnswer] = useState<ExplainState | null>(null);
  useHoldRefresh(open);
  useEffect(() => {
    if (!open) return;
    // A read that comes back after the drawer closed (or reopened) is dropped.
    let live = true;
    read(appId, deploymentId)
      .then((r) => { if (live) setState(r.ok && r.data ? { log: r.data } : { error: r.ok ? "No build log came back." : r.error }); })
      .catch(() => { if (live) setState({ error: "Watchbell didn't answer. Check that it's still running, then try again." }); });
    return () => { live = false; setState(null); setAnswer(null); };
  }, [open, appId, deploymentId, read]);
  const runExplain = () => {
    setAnswer("asking");
    ask(appId, deploymentId)
      .then((r) => setAnswer(r.ok && r.data ? r.data : { error: r.ok ? "No explanation came back." : r.error }))
      .catch(() => setAnswer({ error: "Watchbell didn't answer. Check that it's still running, then try again." }));
  };
  const canExplain = explain && state !== null && "log" in state && answer !== "asking";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto flex h-dvh max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-[780px]">
        <div className="px-[18px] pb-2 pt-4 pr-12">
          <DialogTitle className="text-base">Build log · {title}</DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px] text-ink-soft">Newest build, read from Vercel now<Src kind="api" /></DialogDescription>
          {explain && <Button size="sm" className="mt-2" disabled={!canExplain} onClick={runExplain}>{answer && answer !== "asking" && !("error" in answer) ? "Explain again" : "Explain with AI"}</Button>}
        </div>
        {answer && <Explanation answer={answer} />}
        {state === null ? <p className="px-[18px] pb-4 text-[13px] text-ink-soft">Reading the build log…</p>
          : "error" in state ? <p role="alert" className="px-[18px] pb-4 text-[13px] text-err">{state.error}</p>
            : <BuildLogBody log={state.log} />}
      </DialogContent>
    </Dialog>
  );
}
