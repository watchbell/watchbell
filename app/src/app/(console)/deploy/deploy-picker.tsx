"use client";

import { IconExternalLink } from "@tabler/icons-react";
import Link from "next/link";
import { type KeyboardEvent, useState } from "react";
import { Masked, useMask } from "@/components/alias";
import { buttonClass, fieldClass } from "@/components/kit";
import { rowClass, td, tableClass, TableHead, tdWrap } from "@/components/table";
import type { Host, HostCost, HostedProvider, LangId, LangTile } from "@/data/hosting";
import { afterDeploy, handoffHint, langAfterRepo, nextStep, watchLine } from "@/lib/deploy/target";
import { cn } from "@/lib/utils";

// Hosting › Deploy an app (mockup view "hosting"): 1 the language, 2 the host (free first), 3 the repository and the
// hand-off to the host's own new-project page. Nothing is deployed from here.

export type PickerRepo = { fullName: string; language: string | null; private: boolean };
export type PickerProps = {
  langs: LangTile[];
  hosts: Record<string, Host>;
  repos: PickerRepo[];
  github: boolean; // a GitHub account is connected
  connected: HostedProvider[];
  broken?: HostedProvider[]; // has an account, but every one of them fails
  repoNote?: string | null; // why repositories show no language (GitHub couldn't tell)
  owner: boolean;
  initialRepo?: string; // ?repo=owner/name
};

const COST_TONE: Record<HostCost, string> = {
  free: "bg-ok-soft text-ink",
  "free-card": "bg-brand-soft text-brand",
  trial: "bg-gray-soft text-ink-soft",
  paid: "bg-gray-soft text-ink-soft",
  guide: "bg-warn-soft text-ink",
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2.5 flex items-center gap-2.5 text-[14px] font-medium">
        <span aria-hidden className="grid size-[22px] place-items-center rounded-md border border-line-strong font-mono text-[12px] font-semibold">{n}</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

export function DeployPicker({ langs, hosts, repos, github, connected, broken = [], repoNote, owner, initialRepo }: PickerProps) {
  const first = repos.find((r) => r.fullName === initialRepo) ?? null;
  const [repo, setRepo] = useState<string>(first?.fullName ?? "");
  const [lang, setLang] = useState<LangId>(langAfterRepo(langs[0], first?.language ?? null, false, langs));
  const [touched, setTouched] = useState(false); // the user picked a tile: a repository no longer changes it
  const mask = useMask();
  const states = { connected: new Set(connected), broken: new Set(broken) };
  const [pick, setPick] = useState(0);
  const [steps, setSteps] = useState(false);

  const tile = langs.find((t) => t.id === lang) ?? langs[0];
  const rows = tile.hosts.map((r) => ({ ...r, host: hosts[r.host] })).filter((r) => r.host);
  const chosen = rows[Math.min(pick, rows.length - 1)];
  const host = chosen.host;
  const step = nextStep(host, { ...states, owner });

  const chooseLang = (id: LangId) => { setLang(id); setPick(0); setSteps(false); };
  const chooseRepo = (name: string) => {
    setRepo(name);
    const l = langAfterRepo(tile, repos.find((r) => r.fullName === name)?.language ?? null, touched, langs);
    if (l !== lang) chooseLang(l);
  };
  const onRowKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPick(i); setSteps(false); }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Step n={1} title="What is it written in?">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Language">
          {langs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === lang}
              onClick={() => { setTouched(true); chooseLang(t.id); }}
              className={cn(
                "rounded-lg border px-3 py-2 text-[13.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                t.id === lang ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface hover:bg-hover",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Step>

      <Step n={2} title="Where should it run?">
        <p className="rounded-lg bg-sunken px-3 py-2.5 text-[13.5px] text-ink-soft">{tile.note}</p>
        <div className="mt-2.5 overflow-x-auto rounded-lg border border-line">
          <table className={tableClass} role="grid" aria-label={`Hosts for ${tile.label}`}>
            <TableHead head={["Host", "Cost", "Catch", "Deploys from", "Watchbell can"]} />
            <tbody>
              {rows.map((r, i) => {
                const on = r === chosen;
                return (
                  <tr
                    key={r.host.id}
                    aria-selected={on}
                    tabIndex={0}
                    onClick={() => { setPick(i); setSteps(false); }}
                    onKeyDown={(e) => onRowKey(e, i)}
                    className={cn(rowClass, "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40", on && "bg-brand-soft hover:bg-brand-soft")}
                  >
                    <td className={td}><b className="font-medium">{r.host.name}</b></td>
                    <td className={td}><span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", COST_TONE[r.host.cost])}>{r.host.price}</span></td>
                    <td className={cn(td, tdWrap, "text-ink-soft")}>{r.catch}</td>
                    <td className={cn(td, "font-mono text-[12.5px]")}>{r.host.from}</td>
                    <td className={cn(td, tdWrap, "text-[13px]")}>{watchLine(r.host, states)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Step>

      <Step n={3} title="Source and deploy">
        <div className="grid gap-3 rounded-lg border border-dashed border-line-strong px-3.5 py-3">
          {repos.length ? (
            <label className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium">Repository</span>
              <select value={repo} onChange={(e) => chooseRepo(e.target.value)} className={cn(fieldClass, "w-auto min-w-0 max-w-full py-1")}>
                <option value="">None, I&apos;ll pick it on {host.name}</option>
                {repos.map((r) => <option key={r.fullName} value={r.fullName}>{mask("repo", r.fullName)}{r.private ? " (private)" : ""}</option>)}
              </select>
              {repoNote && <span className="text-[12.5px] text-ink-faint">{repoNote}</span>}
            </label>
          ) : github ? (
            <p className="text-[13px] text-ink-soft">No repositories synced yet. You can pick one on {host.name}.</p>
          ) : owner ? (
            <p className="text-[13px] text-ink-soft"><Link href="/connections?provider=github" className="text-brand hover:underline">Connect GitHub to pick a repository</Link>, or pick one on {host.name}.</p>
          ) : (
            <p className="text-[13px] text-ink-soft">The owner can connect GitHub to pick a repository here; you can pick one on {host.name}.</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 text-[13.5px] [overflow-wrap:anywhere]"><b className="font-medium">{tile.label}</b> on <b className="font-medium">{host.name}</b> · {host.price}{repo ? <> · <span className="font-mono text-[12.5px]"><Masked kind="repo" real={repo} /></span></> : null}</span>
            {step.kind === "deploy" && (
              <a href={step.href} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: "primary" })}>{step.label} <IconExternalLink size={14} aria-hidden /></a>
            )}
            {step.kind === "connect" && <Link href={step.href} className={buttonClass({ variant: "primary" })}>{step.label}</Link>}
            {step.kind === "ask" && <span className="text-[13px] text-ink-soft">{step.label}</span>}
            {step.kind === "guide" && (
              <button type="button" aria-expanded={steps} onClick={() => setSteps(!steps)} className={buttonClass()}>{steps ? "Hide the steps" : step.label}</button>
            )}
          </div>
          {step.kind === "guide" && steps && (
            <ol className="list-decimal space-y-1 pl-5 text-[13.5px]">
              {step.steps.map((s) => <li key={s}>{s}</li>)}
              <li className="list-none pt-1 -ml-5">
                <a href={host.newUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Open {host.name} <IconExternalLink size={13} aria-hidden className="inline" /></a>
              </li>
            </ol>
          )}
          {step.kind === "deploy" && <p className="min-w-0 text-[13px] [overflow-wrap:anywhere]">{handoffHint(host, repo ? mask("repo", repo) : null)}</p>}
          <p className="text-[12.5px] text-ink-soft">
            {afterDeploy(host)}
            {!host.provider && <> <Link href="/uptime" className="text-brand hover:underline">Open Uptime</Link></>}
          </p>
        </div>
      </Step>
    </div>
  );
}
