import Link from "next/link";
import { ExternalLink } from "@/components/external-link";
import { Card } from "@/components/kit";
import { PlainTable } from "@/components/plain-table";
import { SevTag } from "@/components/severity";
import { Src } from "@/components/sources";
import { StateIcon } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import type { DepSeverity } from "@/db/schema";
import type { AppDepsView } from "@/lib/data/deps-db";
import { cveOf } from "@/lib/deps/osv";
import { countBySeverity, SEVERITY_ORDER, upgradesFor } from "@/lib/deps/plan";
import type { Severity } from "@/lib/security/types";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DEPS_COPY } from "@/lib/copy/edition";
import { depsCoverage, NOT_SCANNED_TEXT } from "@/lib/deps/coverage";
import { DepsScanButton } from "./deps-scan-button";

// Details → Dependencies (Stage 9 slice 5): the linked repository's lockfile against OSV.dev (and Dependabot when the
// token may read it). The page only reads ops.dependency_*; the daily job and Scan now write them. A fix is proposed in
// the office ("Open package update PR") and needs the owner's approval and the GitHub PR-write token, or runs by itself
// with "Automatic security fixes"; Watchbell's update PRs show their stage here ("PR #N: waiting for preview" …).

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";
const mono = "font-mono text-[12.5px]";
const UPPER: Record<DepSeverity, Severity> = { critical: "CRITICAL", high: "HIGH", moderate: "MODERATE", low: "LOW", unknown: "UNKNOWN" };

export function DependenciesCard({ app, view, canAct, owner, now, devopsOff = false }: { app: { id: string; name: string }; view: AppDepsView; canAct: boolean; owner: boolean; now: Date; devopsOff?: boolean }) {
  const { repo, scan, vulns } = view;
  // "None known" only after a successful scan; otherwise "Not scanned" and why (1.2.1, owner 24 Oct).
  const cover = depsCoverage(view, devopsOff);
  // 1.2.3 (owner 26 Oct): dev-only advisories are local tooling (never alerted, never shipped), so they get their own
  // row instead of swelling the production count.
  const prodVulns = vulns.filter((v) => !v.dev);
  const devVulns = vulns.filter((v) => v.dev);
  const fixable = upgradesFor(vulns).length;
  return (
    <Card title="Dependencies" meta={<><Src kind="api">OSV.dev</Src>{canAct && repo && !devopsOff && <DepsScanButton appId={app.id} appName={app.name} />}</>} flush>
      <div className="px-[18px] pb-4 pt-2">
        {!cover.scanned || !scan?.scannedAt ? (
          <>
            <p className="flex items-start gap-1.5 text-ink-soft">
              {!cover.scanned && cover.reason === "failed" && <StateIcon state="warn" />}
              <span><span className="font-medium text-ink">Not scanned:</span> {NOT_SCANNED_TEXT[cover.scanned ? "not-yet" : cover.reason]}{!cover.scanned && cover.reason === "failed" && scan?.error && <> {scan.error}</>}</span>
            </p>
            {scan?.scannedAt && <p className="mt-2 text-[12.5px] text-ink-faint">Last tried {ago(scan.scannedAt, now)}.{scan.note && <> {scan.note}</>}</p>}
          </>
        ) : (
          <>
            <dl className={KV}>
              <dt>In production</dt>
              <dd>{prodVulns.length === 0 ? <span className="inline-flex items-center gap-1.5"><StateIcon state="ok" />None known</span> : <SeverityCounts vulns={prodVulns} />}</dd>
              {devVulns.length > 0 && (
                <>
                  <dt>Development tools</dt>
                  <dd>
                    <SeverityCounts vulns={devVulns} />
                    <div className="mt-0.5 text-[12.5px] text-ink-faint">Local development only, no production impact. Not alerted.</div>
                  </dd>
                </>
              )}
              <dt>Lockfile</dt>
              <dd>{scan.lockfilePath ? <><span className={mono}>{scan.lockfilePath}</span><span className="text-ink-faint"> · {scan.packageCount} packages</span></> : <span className="text-ink-faint">None found</span>}</dd>
              <dt>Last scan</dt><dd>{ago(scan.scannedAt, now)}</dd>
            </dl>
            {scan.error && <p className="mt-3 flex items-start gap-1.5 text-ink-soft"><StateIcon state="warn" /><span>The last scan failed: {scan.error} The list below is from the scan before.</span></p>}
            {scan.note && <p className="mt-2 text-[12.5px] text-ink-faint">{scan.note}</p>}
            {cover.paused && <p className="mt-2 text-[12.5px] text-ink-faint">Scans pause while DevOps is off (Manage › Sections); this is the last scan.</p>}
            {view.prs && view.prs.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 text-[13px]">
                {view.prs.map((p) => (
                  <li key={p.number}>
                    <ExternalLink href={`https://github.com/${p.fullName}/pull/${p.number}`} target="_blank" rel="noopener">{p.stageText ?? `PR #${p.number}`}</ExternalLink>
                    <span className="text-ink-faint"> · {ago(p.openedAt, now)}</span>
                  </li>
                ))}
              </ul>
            )}
            {fixable > 0 && (
              <p className="mt-2 text-[12.5px] text-ink-soft">
                {fixable} direct package{fixable === 1 ? " has" : "s have"} a fixed version. {DEPS_COPY.cardProposes}
                {owner && !view.writeConnected && <> It needs the <Link href="/connections?provider=github_write">GitHub (PR write)</Link> token.</>}
              </p>
            )}
          </>
        )}
      </div>
      {cover.scanned && vulns.length > 0 && (
        <PlainTable
          head={["Package", "Version", "Severity", "Advisory"]}
          rows={vulns.map((v) => {
            const cve = cveOf(v.aliases);
            return {
              key: `${v.package}@${v.installedVersion}|${v.vulnId}`,
              state: UPPER[v.severity],
              text: [v.package, v.vulnId, cve, v.summary].filter(Boolean).join(" "),
              row: (
                <tr className={rowClass}>
                  <td className={td}>
                    <span className={mono}>{v.package}</span>
                    {(v.dev || !v.direct) && <div className="mt-0.5 text-xs text-ink-faint">{[v.direct ? null : "transitive", v.dev ? "dev only, local" : null].filter(Boolean).join(" · ")}</div>}
                  </td>
                  <td className={cn(td, mono, "whitespace-nowrap")}>
                    {v.installedVersion} {v.fixedVersion ? <>→ {v.fixedVersion}</> : <span className="font-sans text-ink-faint">· no fix yet</span>}
                  </td>
                  <td className={td}><SevTag severity={UPPER[v.severity]} /></td>
                  <td className={cn(td, tdWrap)}>
                    <a href={`https://osv.dev/vulnerability/${encodeURIComponent(cve ?? v.vulnId)}`} target="_blank" rel="noopener" className={mono}>{cve ?? v.vulnId}</a>
                    {cve && <span className={cn(mono, "ml-1.5 text-xs text-ink-faint")}>{v.vulnId}</span>}
                    {v.summary && <div className="mt-0.5 text-ink-soft">{v.summary}</div>}
                  </td>
                </tr>
              ),
            };
          })}
        />
      )}
    </Card>
  );
}

function SeverityCounts({ vulns }: { vulns: AppDepsView["vulns"] }) {
  const counts = countBySeverity(vulns);
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5"><span className={mono}>{counts[s]}</span><SevTag severity={UPPER[s]} /></span>
      ))}
    </span>
  );
}
