"use client";

import { useState, useTransition } from "react";
import { Button, Card } from "@/components/kit";
import { Src } from "@/components/sources";
import { StateIcon } from "@/components/status";
import type { EnvCheck, EnvFinding } from "@/lib/env-check/check";
import { ago } from "@/lib/time";
import { envCheckAction } from "./env-actions";

// Details → Environment (Watchbell 1.3): the env variable names set on Vercel against the repository's .env.example.
// Only when asked (Check now): nothing runs on a schedule and nothing is stored. Values are never read.

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";

const TEXT: Record<EnvFinding["kind"], (key: string) => string> = {
  "missing-production": (k) => `${k} is in .env.example but not set for Production`,
  "preview-only": (k) => `${k} is set for Preview or Development only`,
  "public-secret": (k) => `${k} is sent to the browser (NEXT_PUBLIC_) but its name looks secret`,
  "not-in-example": (k) => `${k} is set for Production but not listed in .env.example`,
};

export const envFindingText = (f: EnvFinding): string => TEXT[f.kind](f.key);

const EXAMPLE_NOTE: Record<Exclude<EnvCheck["example"], "found">, string> = {
  none: "No .env.example in the repository, so only Vercel's own settings were checked.",
  "no-repo": "Link a repository to compare with its .env.example.",
  unreadable: "The repository's .env.example couldn't be read.",
};

export function EnvCard({ appId }: { appId: string }) {
  const [check, setCheck] = useState<EnvCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    try {
      const r = await envCheckAction(appId);
      if (r.ok && r.data) { setCheck(r.data); setError(null); } else setError(r.ok ? "No answer." : r.error);
    } catch {
      setError("Watchbell didn't answer. Check that it's still running, then try again.");
    }
  });
  return (
    <Card title="Environment" meta={<><Src kind="api">Vercel</Src><Button size="sm" onClick={run} disabled={pending}>{pending ? "Checking…" : "Check now"}</Button></>} flush>
      <div className="px-[18px] pb-4 pt-2">
        {error && <p className="mb-2 flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>{error}</span></p>}
        {!check ? (
          <p className="text-ink-soft">Not checked yet. Check now compares the variable names set on Vercel with .env.example in the repository. Values are never read.</p>
        ) : (
          <>
            <dl className={KV}>
              <dt>Variables on Vercel</dt>
              <dd>{check.names}</dd>
              <dt>Compared with</dt>
              <dd>{check.example === "found" ? <span className="font-mono text-[12.5px]">{check.examplePath}</span> : <span className="text-ink-soft">{EXAMPLE_NOTE[check.example]}</span>}</dd>
              <dt>Checked</dt>
              <dd>{ago(new Date(check.checkedAt), new Date())}</dd>
            </dl>
            {check.findings.length === 0 ? (
              <p className="mt-3 inline-flex items-center gap-1.5"><StateIcon state="ok" />No findings</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-1.5">
                {check.findings.map((f) => (
                  <li key={`${f.kind}:${f.key}`} className="flex items-start gap-1.5"><StateIcon state="warn" /><span>{envFindingText(f)}</span></li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
