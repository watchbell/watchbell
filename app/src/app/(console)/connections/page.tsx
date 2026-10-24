import { asc, inArray } from "drizzle-orm";
import Link from "next/link";
import { Banner, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { credentialProblem } from "@/lib/accounts";
import { pageGate } from "@/lib/auth";
import { folderLabel } from "@/lib/backup/content";
import { driveEnv } from "@/lib/backup/google-oauth";
import { ENV_COPY } from "@/lib/copy/edition";
import { openOrNull } from "@/lib/crypto";
import { readFolder } from "@/lib/data/backup-db";
import { githubCounts } from "@/lib/data/github-db";
import { writeAccess } from "@/lib/data/provider-action-db";
import { serverEnv } from "@/lib/env";
import { isDemo } from "@/lib/mode";
import { type Provider, PROVIDER_INFO } from "@/lib/providers/info";
import { monitoredSummary, SYNC_KIND, syncKind } from "@/lib/sync";
import { expires, lastSync } from "@/lib/time";
import { accessHint } from "@/lib/view/access";
import { type DriveState, driveState } from "@/lib/view/backups";
import { connectionGrid, drawerFromQuery, type TileLine, tileLine } from "@/lib/view/connections";
import { hideEmails } from "@/lib/view/display-name";
import { DriveStateBlock } from "../backups/drive-card";
import { ProviderDrawer } from "./provider-drawer";
import { type PanelAccount, ProviderPanel } from "./provider-panel";
import { SchedulersCard } from "./schedulers-card";

// The Google Drive tile's line (the drawer holds DriveStateBlock with its one next step).
const DRIVE_LINE: Record<DriveState["kind"], TileLine> = {
  env: { state: "off", text: "Not set up" },
  none: { state: "off", text: "Not connected" },
  ok: { state: "ok", text: "Connected" },
  reconnect: { state: "err", text: "Reconnect needed" },
  problem: { state: "warn", text: "Connected · last run failed" },
};

// 1.2 (spec §7): a grid of provider tiles grouped by section (Hosting, Database, DevOps, then Manage for Google
// Drive); each tile opens a drawer with its accounts and the guided credential form.
export default async function ConnectionsPage({ searchParams }: { searchParams?: Promise<{ provider?: string | string[] }> } = {}) {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const opened = drawerFromQuery((await searchParams)?.provider);

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
  const panelAccounts = (provider: Provider): PanelAccount[] => rows.filter((r) => r.provider === provider).map((a) => {
    const kind = syncKind(provider);
    return {
      id: a.id, label: a.label, credentialKind: a.credentialKind, scopeNote: a.scopeNote,
      hint: accessHint(a.provider, access.get(a.id), a.scopeNote),
      expires: expires(a.expiresAt, now), lastSync: lastSync(a.lastSyncAt, now),
      problem: a.problem, unreadable: a.unreadable, watchNew: a.watchNew,
      monitored: provider === "github" ? ghCounts.get(a.id) ?? null
        : kind ? monitoredSummary(resourceRows.filter((r) => r.accountId === a.id), now, kind) : null,
    };
  });
  const broken = rows.filter((r) => r.problem);
  const drive = driveState(driveEnv() !== null, rows.find((r) => r.provider === "drive") ?? null);
  const groups = connectionGrid(rows.filter((r) => r.provider !== "drive"));
  const grid = "grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5";
  const sectionTitle = "mb-2 text-[13px] font-medium text-ink-soft";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "Connections" }]}
        title="Connections"
        sub={`Credentials are encrypted (AES-256-GCM) before they're stored. The key lives in ${ENV_COPY.keyHome}, and credentials never reach the browser. Sync lists everything in an account, and you choose what the console watches.`}
      />
      {broken.length > 0 && (
        <Banner tone="danger" title={`${broken.length} connection${broken.length > 1 ? "s need" : " needs"} attention`}>
          {broken.map((b) => `${b.provider} · ${hideEmails(b.label)}`).join(", ")}. Data from {broken.length > 1 ? "these accounts is" : "this account is"} not being updated.
        </Banner>
      )}
      {groups.map((g) => (
        <section key={g.section} aria-labelledby={`sec-${g.section}`} data-section={g.section}>
          <h2 id={`sec-${g.section}`} className={sectionTitle}>{g.title}</h2>
          <div className={grid}>
            {g.tiles.map((t) => {
              const info = PROVIDER_INFO[t.provider];
              return (
                <ProviderDrawer key={t.provider} name={info.name} note={info.note} icon={info.icon} line={tileLine(t)} defaultOpen={opened === t.provider}>
                  <ProviderPanel provider={t.provider} accounts={panelAccounts(t.provider)} demo={demo} />
                </ProviderDrawer>
              );
            })}
          </div>
        </section>
      ))}
      {/* Mockup connections(): "Monthly backups. The app can only see the files it creates." Single account, OAuth. */}
      <section aria-labelledby="sec-manage" data-section="manage">
        <h2 id="sec-manage" className={sectionTitle}>Manage</h2>
        <div className={grid}>
          <ProviderDrawer name="Google Drive" note="Monthly backups. The app can only see the files it creates (drive.file)." icon="drive" line={DRIVE_LINE[drive.kind]} defaultOpen={opened === "drive"}>
            <div className="px-[18px] py-4">
              <DriveStateBlock state={drive} folderName={folderLabel(driveFolder)} showDisconnect />
              <p className="mt-3 text-[12.5px] text-ink-soft">Schedule, history and restore are on <Link href="/backups">Backups</Link>.</p>
            </div>
          </ProviderDrawer>
        </div>
      </section>
      <SchedulersCard />
    </>
  );
}
