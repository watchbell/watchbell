import { IconBolt, IconBrandGithub, IconBrandGoogleDrive, IconCloud, IconDatabase, IconFlame, IconTriangle } from "@tabler/icons-react";
import { ENV_COPY } from "@/lib/copy/edition";
import { asc, inArray } from "drizzle-orm";
import Link from "next/link";
import { Banner, Card, EmptyState, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { AccountChip } from "@/components/resource";
import { StateIcon, Status } from "@/components/status";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { credentialProblem } from "@/lib/accounts";
import { pageGate } from "@/lib/auth";
import { folderLabel } from "@/lib/backup/content";
import { driveEnv } from "@/lib/backup/google-oauth";
import { openOrNull } from "@/lib/crypto";
import { readFolder } from "@/lib/data/backup-db";
import { githubCounts } from "@/lib/data/github-db";
import { writeAccess } from "@/lib/data/provider-action-db";
import { serverEnv } from "@/lib/env";
import { isDemo } from "@/lib/mode";
import { type Provider, PROVIDER_INFO, PROVIDERS } from "@/lib/providers/info";
import { monitoredSummary, SYNC_KIND, syncKind } from "@/lib/sync";
import { expires, lastSync } from "@/lib/time";
import { type AccessHint, accessHint } from "@/lib/view/access";
import { driveState } from "@/lib/view/backups";
import { hideEmails } from "@/lib/view/display-name";
import { RemoveAccountButton, RetestButton } from "./account-actions";
import { AccountDialog } from "./account-dialog";
import { DriveStateBlock } from "../backups/drive-card";
import { GithubSyncButton } from "./github-sync-button";
import { SchedulersCard } from "./schedulers-card";
import { SyncButton } from "./sync-dialog";

const ICONS = { triangle: IconTriangle, bolt: IconBolt, database: IconDatabase, flame: IconFlame, cloud: IconCloud, github: IconBrandGithub };
const HINT_STATE = { ok: "ok", off: "warn", faint: "off" } as const;

// Stage 6 A7: under the Access note, whether the console's actions work with this credential (mockup connections()).
function AccessLine({ hint }: { hint: AccessHint }) {
  return (
    <div className={`mt-0.5 flex items-start gap-1.5 text-[12px] ${hint.tone === "faint" ? "text-ink-faint" : ""}`}>
      <span className="mt-px"><StateIcon state={HINT_STATE[hint.tone]} size={14} /></span>
      <span>{hint.text}</span>
    </div>
  );
}

export default async function ConnectionsPage() {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;

  const key = serverEnv().OPS_ENCRYPTION_KEY;
  // Only the kinds Sync stores: the domain rows stage 4 keeps under the Vercel account are not "monitored resources".
  // Both reads go out together (perf P4).
  const [accountRows, resourceRows] = await Promise.all([
    db().select().from(accounts).orderBy(asc(accounts.createdAt)),
    db().select({ accountId: resources.accountId, kind: resources.kind, monitored: resources.monitored, firstSeenAt: resources.firstSeenAt, goneAt: resources.goneAt })
      .from(resources).where(inArray(resources.kind, Object.values(SYNC_KIND))),
  ]);
  // The last write attempt per account (A6), one read for the page.
  const [access, ghCounts, driveFolder] = await Promise.all([writeAccess(accountRows.map((a) => a.id)), githubCounts(), readFolder()]);
  // Demo: the made-up accounts hold no credential at all (a placeholder that never decrypts), so they read as demo
  // accounts instead of "Can't read the stored credential". Sync, Retest and the rest answer "Not available in the demo".
  const demo = isDemo();
  const rows = accountRows.map((a) => {
    const unreadable = a.provider === "drive" || demo ? null : credentialProblem(openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, key));
    return { ...a, unreadable: unreadable !== null, problem: unreadable ?? (a.status === "error" ? a.lastError : null) };
  });
  const now = new Date();
  const summaryFor = (accountId: string, provider: string) => monitoredSummary(resourceRows.filter((r) => r.accountId === accountId), now, syncKind(provider));
  const broken = rows.filter((r) => r.problem);
  const th = "border-y border-line bg-surface-2 px-3 py-2 text-left text-[12.5px] font-medium text-ink-soft first:pl-[18px]";
  const td = "border-b border-line px-3 py-[9px] align-middle first:pl-[18px]";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Connections" }]}
        title="Connections"
        sub={`Credentials are encrypted (AES-256-GCM) before they're stored. The key lives in ${ENV_COPY.keyHome}, and credentials never reach the browser. Sync lists everything in an account, and you choose what the console watches.`}
      />
      {broken.length > 0 && (
        <Banner tone="danger" title={`${broken.length} connection${broken.length > 1 ? "s need" : " needs"} attention`}>
          {broken.map((b) => `${b.provider} · ${hideEmails(b.label)}`).join(", ")}. Data from {broken.length > 1 ? "these accounts is" : "this account is"} not being updated.
        </Banner>
      )}
      {PROVIDERS.map((provider: Provider) => {
        const info = PROVIDER_INFO[provider];
        const Icon = ICONS[info.icon];
        const list = rows.filter((r) => r.provider === provider);
        return (
          <section key={provider} className="min-w-0 rounded-lg border border-line bg-surface">
            <div className="flex items-center gap-3 px-[18px] pb-2.5 pt-3.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
              <div>
                <h2 className="text-[15px]">{info.name}</h2>
                <p className="mt-px text-[12.5px] text-ink-soft">{info.note}</p>
              </div>
              <div className="ml-auto">
                {info.multiAccount || list.length === 0
                  ? <AccountDialog provider={provider} triggerLabel={list.length === 0 && !info.multiAccount ? "Connect" : undefined} />
                  : <span className="text-[12.5px] text-ink-faint">Single account</span>}
              </div>
            </div>
            {list.length === 0 ? (
              <div className="border-t border-line"><EmptyState title={`No ${info.name} account yet`}>Connect one to start watching it.</EmptyState></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead><tr>{["Account", "Credential", "Access", "Expires", "Monitored", "Last sync", "Status", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {list.map((a) => (
                      <tr key={a.id} className="hover:bg-hover">
                        <td className={td}><AccountChip name={a.label} /></td>
                        <td className={`${td} whitespace-nowrap`}>{a.credentialKind}</td>
                        <td className={`${td} min-w-40 text-ink-soft`}>
                          {a.scopeNote}
                          {(() => { const hint = accessHint(a.provider, access.get(a.id), a.scopeNote); return hint && <AccessLine hint={hint} />; })()}
                        </td>
                        <td className={`${td} whitespace-nowrap text-ink-soft`}>{expires(a.expiresAt, now)}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {provider === "github"
                            ? (() => { const c = ghCounts.get(a.id); return c ? <><span className="font-mono">{c.repos}</span><span className="text-ink-faint"> repos · {c.linked} linked</span></> : <span className="text-ink-faint">—</span>; })()
                            : syncKind(provider)
                            ? (() => { const s = summaryFor(a.id, a.provider); return s.total === 0 ? <span className="text-ink-faint">—</span> : <><span className="font-mono">{s.on}</span><span className="text-ink-faint"> of {s.total}</span>{s.fresh > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-px font-mono text-[10.5px] text-brand">{s.fresh} new</span>}</>; })()
                            : <span className="text-ink-faint">—</span>}
                        </td>
                        <td className={`${td} whitespace-nowrap text-ink-soft`}>{lastSync(a.lastSyncAt, now)}</td>
                        <td className={`${td} min-w-40`}>{a.problem ? <Status state="err">{hideEmails(a.problem)}</Status> : <Status state="ok">{demo ? "Demo account" : "Connected"}</Status>}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          <div className="flex gap-1.5">
                            {!a.problem && provider !== "github_write" && (provider === "github"
                              ? <GithubSyncButton accountId={a.id} />
                              : <SyncButton accountId={a.id} title={`${info.name} · ${hideEmails(a.label)}`} watchNew={a.watchNew} kind={SYNC_KIND[provider]} />)}
                            {!a.unreadable && <RetestButton accountId={a.id} />}
                            <AccountDialog provider={provider} replace={{ id: a.id, label: a.label }} primary={a.problem !== null} />
                            <RemoveAccountButton accountId={a.id} title={`${info.name} · ${hideEmails(a.label)}`} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      {/* Mockup connections(): "Monthly backups. The app can only see the files it creates." Single account, OAuth. */}
      <Card title={<span className="inline-flex items-center gap-2"><IconBrandGoogleDrive size={18} className="text-ink-soft" />Google Drive</span>} meta={<>Monthly backups · <Link href="/backups">Backups</Link></>}>
        <p className="mb-2.5 text-[12.5px] text-ink-soft">Monthly backups. The app can only see the files it creates (drive.file).</p>
        <DriveStateBlock state={driveState(driveEnv() !== null, rows.find((r) => r.provider === "drive") ?? null)} folderName={folderLabel(driveFolder)} showDisconnect />
      </Card>
      <SchedulersCard />
    </>
  );
}
