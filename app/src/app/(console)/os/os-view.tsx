"use client";

import { IconExternalLink, IconShieldCheck } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Banner, Button, Card, EmptyState } from "@/components/kit";
import { SevTag } from "@/components/severity";
import { StateIcon } from "@/components/status";
import { rowClass, td, tableClass, TableHead } from "@/components/table";
import type { StoredScan } from "@/lib/data/os-scan-db";
import type { OsUpdate } from "@/lib/os/scan";
import { kernelNoticesUrl, ubuntuCveUrl, ubuntuPackageUrl, usnUrl } from "@/lib/os/ubuntu";
import { fixAllCommand, fixCommand, kernelAdvice, scoreSeverity, splitUpdates } from "@/lib/os/view";
import { cvssText, nvdUrl } from "@/lib/security/links";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { scanNowAction } from "./os-actions";

// DevOps › Security › OS vulnerabilities: the last scan of this machine. What to act on first (the kernel, security
// updates with the CVEs they fix), then other updates and OSV's no-fix-yet counts folded away. Watchbell never runs
// the commands; they are there to copy.

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dt]:text-ink-soft";
const mono = "font-mono text-[12.5px]";
const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

function Command({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md bg-code-bg px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-[12px] text-code-text [overflow-wrap:anywhere]">{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

// One waiting update: the package and versions, the CVEs it fixes (score, Ubuntu priority, links), the command.
function UpdateItem({ u }: { u: OsUpdate }) {
  return (
    <li className="grid gap-2 border-t border-line px-[18px] py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <b className="font-medium">{u.source}</b>
        <span className={cn(mono, "text-ink-faint [overflow-wrap:anywhere]")}>{u.installed} → {u.candidate}</span>
        {u.security && <span className="text-[12px] text-ink-soft">Ubuntu security update</span>}
      </div>
      {u.error ? (
        <p className="flex items-start gap-1.5 text-[13px] text-ink-soft"><StateIcon state="warn" /><span>Fixed CVEs couldn&apos;t be read: {u.error}</span></p>
      ) : u.fixes.length === 0 ? (
        <p className="text-[13px] text-ink-soft">No CVE listed for this update.</p>
      ) : (
        <ul className="grid gap-2">
          {u.fixes.map((f) => (
            <li key={f.cve} className="min-w-0 rounded-md border border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <SevTag severity={scoreSeverity(f.cvss3)} />
                {cvssText(f.cvss3) && <span className={cn(mono, "font-medium")} title="CVSS v3 base score">{cvssText(f.cvss3)}</span>}
                <a href={ubuntuCveUrl(f.cve)} {...ext} className={cn(mono, "text-brand hover:underline")}>{f.cve}</a>
                {f.priority && <span className="text-[12px] text-ink-faint">Ubuntu priority: {f.priority}</span>}
              </div>
              {f.summary && <p className="mt-1 text-[13px] text-ink-soft">{f.summary}</p>}
              <div className="mt-1 flex flex-wrap gap-x-3 text-[12.5px]">
                {f.usns.map((n) => usnUrl(n) && <a key={n} href={usnUrl(n)!} {...ext} className="text-brand hover:underline">{n}</a>)}
                {nvdUrl(f.cve) && <a href={nvdUrl(f.cve)!} {...ext} className="text-brand hover:underline">NVD</a>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Command text={fixCommand(u)} />
    </li>
  );
}

export function OsView({ initial, owner, demo, now }: { initial: StoredScan | null; owner: boolean; demo: boolean; now?: Date }) {
  const [scan, setScan] = useState<StoredScan | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const at = now ?? new Date();

  const scanNow = () => start(async () => {
    try {
      const r = await scanNowAction();
      if (r.ok && r.data) { setScan(r.data); setError(null); } else setError(r.ok ? "No answer." : r.error);
    } catch {
      setError("Watchbell didn't answer. Check that it's still running, then try again.");
    }
  });
  const button = owner && !demo
    ? <Button size="sm" variant={scan ? "secondary" : "primary"} onClick={scanNow} disabled={pending}>{pending ? "Scanning… (up to a minute)" : "Scan now"}</Button>
    : null;

  if (!scan) {
    return (
      <Card flush>
        <EmptyState icon={IconShieldCheck} title="Not scanned yet" action={button}>
          {owner ? "The daily job scans this machine; Scan now does it right away." : "The daily job scans this machine; the owner can scan now."}
          {error && <p className="mt-2 text-err">{error}</p>}
        </EmptyState>
      </Card>
    );
  }

  const { security, other } = splitUpdates(scan.updates);
  const fixAll = fixAllCommand(security);
  const advice = scan.kernel ? kernelAdvice(scan.kernel) : null;
  const backlog = Object.entries(scan.backlog.counts).sort((a, b) => b[1] - a[1]);
  const fixes = new Set(security.flatMap((u) => u.fixes.map((f) => f.cve))).size;
  return (
    <>
      {demo && <Banner tone="info" title="Made-up data: the demo doesn't scan." />}
      {error && <Banner tone="danger" title="Scan now failed">{error}</Banner>}
      {scan.failedAt && scan.error && (
        <Banner tone="warning" title={`The last scan failed ${ago(new Date(scan.failedAt), at)}`}>{`${scan.error} These are the results from ${ago(new Date(scan.scannedAt), at)}.`}</Banner>
      )}
      {scan.status === "unsupported" && <Banner tone="info" title="This machine isn't checked">{scan.error ?? ""}</Banner>}
      {/* Review I3: a scan that failed with nothing good to fall back on shows only the error, never an all-clear. */}
      {scan.status === "error" && <Banner tone="danger" title="The scan failed">{scan.error ?? "Unknown error."}</Banner>}

      <Card title="This machine" meta={button}>
        <dl className={KV}>
          <dt>System</dt><dd>{scan.system ?? "Unknown"}</dd>
          <dt>Packages</dt><dd>{scan.packages.toLocaleString("en-US")} installed</dd>
          <dt>Last scan</dt><dd>{ago(new Date(scan.scannedAt), at)}</dd>
          {scan.aptListsAgeHours !== null && (
            <><dt>apt package lists</dt><dd className={scan.aptListsAgeHours > 48 ? "text-warn-icon" : undefined}>
              updated {scan.aptListsAgeHours < 1 ? "within the hour" : `${scan.aptListsAgeHours} h ago`}{scan.aptListsAgeHours > 48 ? ": run sudo apt update, or updates may be missing here" : ""}
            </dd></>
          )}
          {!scan.failedAt && scan.status === "ok" && scan.error && <><dt>Note</dt><dd className="text-ink-soft">{scan.error}</dd></>}
        </dl>
      </Card>

      {scan.status === "ok" && (<>
      {scan.kernel && advice && (
        <Card title="Kernel" meta={<a href={kernelNoticesUrl(scan.codename ?? "jammy")} {...ext} className="inline-flex items-center gap-1 text-brand hover:underline">What Ubuntu&apos;s kernel updates fix <IconExternalLink size={13} aria-hidden /></a>}>
          <p className="flex items-start gap-1.5"><StateIcon state={advice.state} /><span>{advice.text}</span></p>
          <dl className={cn(KV, "mt-2")}>
            <dt>Running</dt><dd className={mono}>{scan.kernel.running ?? "Unknown"}{scan.kernel.runningVersion ? ` (${scan.kernel.runningVersion})` : ""}</dd>
            <dt>Newest installed</dt><dd className={mono}>{scan.kernel.newestInstalled ?? "Unknown"}</dd>
          </dl>
          {advice.command && <div className="mt-2.5"><Command text={advice.command} /></div>}
          <p className="mt-2 text-[12.5px] text-ink-faint">Ubuntu tracks thousands of kernel CVEs; running the newest kernel it ships is how they get fixed, so Watchbell doesn&apos;t list them one by one.</p>
        </Card>
      )}

      <Card
        title={security.length ? `Security updates waiting (${security.length})` : "Security updates"}
        meta={security.length ? `${fixes} CVE${fixes === 1 ? "" : "s"} fixed by them` : undefined}
        flush
      >
        {security.length ? (
          <>
            {fixAll && <div className="px-[18px] pb-3"><p className="mb-1.5 text-[13px] text-ink-soft">Install them all at once:</p><Command text={fixAll} /></div>}
            <ul aria-label="Security updates waiting">{security.map((u) => <UpdateItem key={u.source} u={u} />)}</ul>
          </>
        ) : (
          <p className="flex items-start gap-1.5 px-[18px] pb-4"><StateIcon state="ok" /><span>No security update is waiting.</span></p>
        )}
      </Card>

      {other.length > 0 && (
        <Card flush>
          <details className="px-[18px] py-3">
            <summary className="cursor-pointer select-none font-medium">Other updates ({other.length})</summary>
            <p className="mt-1 text-[13px] text-ink-soft">Bug fixes and updates from other repositories; not listed as security fixes.</p>
            <ul className="mt-2 grid gap-1 text-[13px]">
              {other.map((u) => <li key={u.source}><b className="font-medium">{u.source}</b> <span className={cn(mono, "text-ink-faint")}>{u.installed} → {u.candidate}</span></li>)}
            </ul>
            <div className="mt-2.5"><Command text={fixAllCommand(other) ?? ""} /></div>
          </details>
        </Card>
      )}

      <Card flush>
        <details className="px-[18px] py-3">
          <summary className="cursor-pointer select-none font-medium">
            No fix yet ({scan.backlog.error ? "couldn't be read" : `${scan.backlog.total.toLocaleString("en-US")} advisories in ${backlog.length} packages`})
          </summary>
          <p className="mt-1 text-[13px] text-ink-soft">
            Advisories OSV.dev lists for the installed packages without a fix it knows of: often low priority, deferred, or in
            universe packages Ubuntu doesn&apos;t support. Packages with an update waiting are left out (see above). OSV can lag
            Ubuntu, so open a package to see Ubuntu&apos;s current status.
          </p>
          {scan.backlog.error ? <p className="mt-2 text-ink-soft">{scan.backlog.error}</p> : (
            <div className="mt-2 overflow-x-auto">
              <table className={tableClass}>
                <TableHead head={["Package", "Advisories", ""]} />
                <tbody>
                  {backlog.slice(0, 25).map(([name, n]) => (
                    <tr key={name} className={rowClass}>
                      <td className={cn(td, mono)}>{name}</td>
                      <td className={td}>{n.toLocaleString("en-US")}</td>
                      <td className={td}><a href={ubuntuPackageUrl(name, scan.codename ?? "jammy")} {...ext} className="inline-flex items-center gap-1 text-brand hover:underline">Ubuntu&apos;s tracker <IconExternalLink size={13} aria-hidden /></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {backlog.length > 25 && <p className="mt-1.5 text-[12.5px] text-ink-faint">And {backlog.length - 25} more packages.</p>}
            </div>
          )}
        </details>
      </Card>
      </>)}
    </>
  );
}
