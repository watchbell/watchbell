"use client";

import { useState, useTransition } from "react";
import { Button, Card } from "@/components/kit";
import { Src } from "@/components/sources";
import { StateIcon } from "@/components/status";
import type { PrCheckRow, PrChecks } from "@/lib/precheck/pr-checks";
import type { Marker } from "@/lib/precheck/report";
import type { State } from "@/lib/status";
import { ago } from "@/lib/time";
import { prChecksAction } from "./pr-actions";

// Details → Pull requests (Watchbell 1.4): the open pull requests and what the pre-deploy check (a GitHub Actions
// workflow in the app's repository) commented on each. Only when asked: nothing runs on a schedule and nothing is stored.

const VERDICT: Record<Marker["verdict"], { state: State; label: string }> = {
  fix: { state: "err", label: "Fix before merging" },
  check: { state: "warn", label: "Check before merging" },
  ok: { state: "ok", label: "No new problems" },
};

export function prRowStatus(row: PrCheckRow): { state: State; label: string } {
  if (row.state === "unread") return { state: "unknown", label: "Couldn't read this pull request's comments" };
  if (row.state === "none" || !row.marker) return { state: "off", label: "Not checked — add the pre-deploy check to this repository" };
  if (row.state === "old") return { state: "unknown", label: "Checked an older commit" };
  return VERDICT[row.marker.verdict];
}

export function prCounts(c: Marker["counts"]): string {
  const parts = (["critical", "high", "moderate", "low"] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  if (c.secrets) parts.push(`${c.secrets} possible secret${c.secrets === 1 ? "" : "s"}`);
  if (c.env) parts.push(`${c.env} env name${c.env === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function PullRequestsCard({ appId }: { appId: string }) {
  const [checks, setChecks] = useState<PrChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    try {
      const r = await prChecksAction(appId);
      if (r.ok && r.data) { setChecks(r.data); setError(null); } else setError(r.ok ? "No answer." : r.error);
    } catch {
      setError("Watchbell didn't answer. Check that it's still running, then try again.");
    }
  });
  return (
    <Card title="Pull requests" meta={<><Src kind="api">GitHub</Src><Button size="sm" onClick={run} disabled={pending}>{pending ? "Checking…" : "Check open pull requests"}</Button></>} flush>
      <div className="px-[18px] pb-4 pt-2">
        {error && <p className="mb-2 flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>{error}</span></p>}
        {!checks ? (
          <p className="text-ink-soft">Not checked yet. This reads the open pull requests and the Watchbell pre-deploy check&apos;s comment on each.</p>
        ) : checks.rows.length === 0 ? (
          <p className="inline-flex items-center gap-1.5"><StateIcon state="ok" />No open pull requests in <span className="font-mono text-[12.5px]">{checks.repo}</span></p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {checks.rows.map((r) => {
                const s = prRowStatus(r);
                const found = r.marker && r.state !== "none" ? prCounts(r.marker.counts) : "";
                return (
                  <li key={r.number} className="flex items-start gap-1.5">
                    <StateIcon state={s.state} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">#{r.number} {r.title}</a> : <>#{r.number} {r.title}</>}
                      {r.draft && <span className="text-ink-soft"> (draft)</span>}
                      <span className="block text-ink-soft">{s.label}{found ? `: ${found}` : ""}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-[12.5px] text-ink-soft">{checks.repo} · checked {ago(new Date(checks.checkedAt), new Date())}</p>
          </>
        )}
      </div>
    </Card>
  );
}
