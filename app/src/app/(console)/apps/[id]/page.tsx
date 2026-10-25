import { IconExternalLink } from "@tabler/icons-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HourBars, Sparkline, UptimeBars } from "@/components/charts";
import { NoDeployments, NoMonitors } from "@/components/empty-states";
import { Banner, Card, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { Masked } from "@/components/alias";
import { Recommendations } from "@/components/recommendations";
import { ResourceBadge } from "@/components/resource";
import { SevTag } from "@/components/severity";
import { Src } from "@/components/sources";
import { StateIcon, Status } from "@/components/status";
import { PlainTable } from "@/components/plain-table";
import { RowMenu } from "@/components/row-menu";
import { ExternalLink } from "@/components/external-link";
import { rowClass, td, tdWrap } from "@/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePageMember } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { listRecommendations } from "@/lib/data/advisor-db";
import { getApp } from "@/lib/data/apps-db";
import { aliasBook, databaseOptions, listDomains } from "@/lib/data/cached";
import { listDeployments } from "@/lib/data/deployments-db";
import { appMetrics, productionDeploys } from "@/lib/data/metrics-db";
import { appDepsView } from "@/lib/data/deps-db";
import { pausedSections } from "@/lib/data/sections-db";
import { type AppRepoView, appRepoView } from "@/lib/data/github-db";
import { readEol } from "@/lib/data/network-db";
import { suggestRepo } from "@/lib/github/links";
import { actionsStatus, linkSourceText, suggestionWhy } from "@/lib/view/github";
import { isUuid } from "@/lib/ids";
import { suggestDatabase } from "@/lib/links";
import { type EolData, eolLine } from "@/lib/security/eol";
import type { SecurityRow } from "@/lib/security/types";
import { ago } from "@/lib/time";
import { problemsOf } from "@/lib/view/why";
import { cn } from "@/lib/utils";
import { appDeployTargets } from "@/lib/view/deploy-actions";
import { deployDays, deployTicks } from "@/lib/view/deploy-marks";
import { dbAlias, hideRec } from "@/lib/view/display-name";
import { isStale, type PageViewsView } from "@/lib/view/pageviews";
import { lastDeployText, longDate, msText, pct, shortSha } from "@/lib/view/format";
import { appStatus, canAct, monitorStatus } from "@/lib/view/labels";
import { DomainMoved } from "../../uptime/domain-moved";
import { DomainsCell } from "./domains-cell";
import { openInLinks } from "@/lib/view/open-in";
import { vercelLogsUrl } from "@/lib/view/logs";
import { outboundLinks } from "@/lib/demo/links";
import { isVulnerable, securityNote } from "@/lib/view/security";
import { BAR_DAYS, lastDays, UPTIME_DAYS, uptimeBars, uptimePct } from "@/lib/view/uptime";
import { DbCell } from "../app-table";
import { DEPLOY_HEAD, deploymentRows } from "../../deployments/deployment-rows";
import { LogViewer } from "../../logs/log-viewer";
import { AppActions, type DeployRef, PromoteStaged } from "./app-actions";
import { DependenciesCard } from "./deps-card";
import { LinkDialog } from "./link-dialog";
import { ConfirmRepo, RefreshActionsButton, RepoDialog } from "./repo-dialog";
import { SecurityCheckButton } from "./security-check-button";
import { WhyStatus } from "./why-status";

// Pause monitors, Remove from console, Security → Check now (up to ~25 s) and the Why dialog's Ask (a provider answer,
// a router combo up to ~25 s) run as this page's server actions. Vercel Hobby allows 60 s.
export const maxDuration = 60;

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";
const mono = "font-mono text-[12.5px]";

// ?tab= opens a tab directly (Applications → row menu → View logs links to ?tab=logs).
const TAB_IDS = ["details", "metrics", "deployments", "logs"] as const;

export default async function AppPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const member = await requirePageMember();
  // An id that isn't a UUID or isn't a watched app is a 404, never a database error.
  if (!isUuid(id)) notFound();
  const now = new Date();
  const act = canAct(member.role);
  // Perf P4: the app and everything else on the page are read together. They only need the id, already a valid UUID;
  // for an id that isn't a watched app the extra reads come back empty and the page is a 404 as before.
  // The Advisor's items for this app (a side card: left out if its row can't be read). Started with the reads below.
  const recsRead = listRecommendations(now, id).catch(() => null);
  const [app, metrics, deploys, prodDeploys, eol, domains, options, book, repoView, depsView, offSections] = await Promise.all([
    getApp(id, now),
    appMetrics(id, now),
    listDeployments({ appId: id }),
    productionDeploys(id, new Date(now.getTime() - BAR_DAYS * 86_400_000)),
    readEol(),
    listDomains(),
    act ? databaseOptions() : Promise.resolve([]),
    aliasBook(),
    // Stage 7 (B7): the GitHub repository and its Actions status; never fails the page.
    appRepoView(id).catch(() => null),
    // Stage 9 slice 5: the linked repository's dependency scan; never fails the page.
    appDepsView(id).catch(() => null),
    // DevOps off: no GitHub reads, so the Dependencies card says why it isn't scanned (cached with the layout's read).
    pausedSections(),
  ]);
  if (!app) notFound();
  const stored = await recsRead;
  // Privacy: databases by alias, no emails, in the Advisor's text and the "Open in" menu (lib/view/display-name.ts).
  const recs = stored && stored.map((r) => hideRec(r, book));
  // Demo: no link out to Vercel, the live site or the repository (they are made up), so no Open in and no Open site.
  const links = outboundLinks();
  const logsUrl = member.role === "viewer" || !links ? null : vercelLogsUrl(app.teamSlug, app.name);
  const s = appStatus(app);
  // "Why": where the problem is and what to do, for a Degraded or Down app. The database is shown by its alias.
  const problems = problemsOf({ ...app, database: app.database ? { id: app.database.id, kind: app.database.kind, name: dbAlias(book, app.database.id) } : null }, now);
  // 5c slots (R2: owner only): "Ask AI" in the Why dialog and the agents' AI notes for this app.
  const { WhyAiSlot: WhyAi, AiNotesSlot: AiNotes, DevNotesSlot: DevNotes } = extensions;
  const whyAi = member.role === "owner" && WhyAi ? <WhyAi appId={app.id} /> : null;
  const aiNotes = member.role === "owner" && AiNotes ? <AiNotes appId={app.id} /> : null;
  const paused = app.monitors.length > 0 && app.monitors.every((m) => m.ownerPaused);
  const siteUrl = links ? `https://${app.domain}` : null;
  // P2: "Open in" lists only what is known; every role sees it because it only links.
  // Stage 6: what Redeploy, Roll back and the rolled-back banner's Promote act on (A9: a READY production deployment
  // newer than the current one means the app was rolled back and new pushes don't go live).
  const targets = appDeployTargets(deploys);
  const refOf = (id: string | null): DeployRef => {
    const d = id ? deploys.find((x) => x.externalId === id) : undefined;
    return d ? { id: d.externalId, sha: shortSha(d.commitSha).replace("—", "") } : null;
  };
  const staged = refOf(targets.stagedId);
  const askedTab = TAB_IDS.find((t) => t === sp.tab) ?? "details";
  const startTab = askedTab === "logs" && member.role === "viewer" ? "details" : askedTab;
  const zoneDomain = domains.find((d) => d.appId === app.id && d.zoneName);
  const openIn = !siteUrl ? [] : openInLinks({
    teamSlug: app.teamSlug, projectName: app.name, repo: app.repo, repoType: app.repoType, siteUrl,
    dbs: app.database ? [{ ...app.database, name: dbAlias(book, app.database.id) }] : [], zone: zoneDomain ? { accountId: zoneDomain.cfAccountId, name: zoneDomain.zoneName! } : null,
  });

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Applications", href: "/apps" }, { label: app.name }]}
        badge={<ResourceBadge kind="app" />}
        title={app.name}
        actions={<><WhyStatus state={s.state} label={s.label} problems={problems} nowMs={now.getTime()} aiSlot={whyAi} />{openIn.length > 0 && <RowMenu button label="Open in" items={openIn.map((x) => (x === "---" ? x : { label: x.label, href: x.href }))} />}{act && <AppActions app={{ id: app.id, name: app.name, siteUrl, paused, monitorCount: app.monitors.length }} owner={member.role === "owner"} current={refOf(targets.currentId)} previous={refOf(targets.previousId)} rolledBack={staged !== null} />}</>}
      />
      {staged && (
        <div className="mb-4">
          <Banner tone="warning" title="Rolled back: new pushes don't go live until you promote one." action={act ? <PromoteStaged app={{ id: app.id, name: app.name }} staged={staged} /> : undefined} />
        </div>
      )}
      <Tabs defaultValue={startTab} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          {member.role !== "viewer" && <TabsTrigger value="logs">Logs</TabsTrigger>}
        </TabsList>

        <TabsContent value="details">
          <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-2">
            <Card title="Details" meta={<Src kind="api" />}>
              <dl className={KV}>
                <dt>Name</dt><dd><Masked kind="app" real={app.name} /></dd>
                <dt>Domains</dt>
                <dd><DomainsCell data={app.domainLines} link={links} /></dd>
                <dt>Framework</dt><dd>{app.framework ?? "—"}</dd>
                <dt>Function region</dt><dd className={cn(mono, !app.functionRegions.length && "text-ink-faint")}>{app.functionRegions.join(", ") || "—"}</dd>
                <dt>Production branch</dt><dd className={mono}>{app.productionBranch ?? "—"}</dd>
                <dt>Repository</dt><dd className={cn(mono, !app.repo && "text-ink-faint")}>{app.repo ? <Masked kind="repo" real={app.repo} /> : "—"}</dd>
                <dt>Created</dt><dd>{app.createdAt ? longDate(app.createdAt) : "—"}</dd>
              </dl>
            </Card>
            <Card title="Status">
              <dl className={KV}>
                <dt>Status</dt><dd><WhyStatus state={s.state} label={s.label} problems={problems} nowMs={now.getTime()} aiSlot={whyAi} /></dd>
                <dt>Database</dt>
                <dd>
                  {app.database ? <DbCell db={app.database} /> : <span className="text-ink-faint">None</span>}
                  {act && <> <LinkDialog app={{ id: app.id, name: app.name }} options={options} current={app.database?.id ?? null} suggested={suggestDatabase(app.name, options)} /></>}
                </dd>
                <dt>Uptime 30 days</dt><dd className={mono}>{pct(app.uptime30)}</dd>
                <dt>Response 24 h</dt><dd className={mono}>p50 {msText(app.response.p50)} · p95 {msText(app.response.p95)}</dd>
                <dt>Last deploy</dt>
                <dd>{app.lastDeploy ? <><span className={mono}>{shortSha(app.lastDeploy.commitSha)}</span> · {lastDeployText(app.lastDeploy, now)}</> : "—"}</dd>
                <dt>Monitors</dt>
                <dd>
                  {app.monitors.length === 0 ? <span className="text-ink-faint">None</span> : app.monitors.map((m) => {
                    const ms = monitorStatus({ ...m, appGone: app.gone });
                    const bad = (ms.state === "err" || ms.state === "warn") && !m.maintUntil;
                    const inner = <><StateIcon state={ms.state} /><span className="sr-only">{ms.label}: </span><span className={mono}>{m.path}</span></>;
                    // A red or yellow monitor links to where the problem is handled (the Uptime page).
                    return bad ? (
                      <Link key={m.id} href="/uptime" title={`${ms.label}. See why on Uptime`} className="mr-2.5 inline-flex items-center gap-1.5">{inner}</Link>
                    ) : (
                      <span key={m.id} title={ms.label} className="mr-2.5 inline-flex items-center gap-1.5">{inner}</span>
                    );
                  })}
                  {/* Watchbell 1.2.1: a monitor still on the app's old domain */}
                  {app.monitors.filter((m) => m.move && !app.gone).map((m) => (
                    <div key={`move-${m.id}`} className="mt-1"><DomainMoved monitorId={m.id} from={m.move!.from} to={m.move!.to} canAct={act} /></div>
                  ))}
                </dd>
              </dl>
            </Card>
          </div>
          <div className="mt-4">
            <SecurityCard app={{ id: app.id, name: app.name }} security={app.security} canAct={act && !app.gone} now={now} eol={eol} />
          </div>
          {depsView && repoView && (repoView.connected || repoView.link) && (
            <div className="mt-4">
              <DependenciesCard app={{ id: app.id, name: app.name }} view={depsView} canAct={act && !app.gone} owner={member.role === "owner"} now={now} devopsOff={offSections.has("devops")} />
            </div>
          )}
          {repoView && (repoView.connected || repoView.link) && (
            <div className="mt-4">
              <RepositoryCard app={{ id: app.id, name: app.name }} view={repoView} suggestion={repoView.link ? null : suggestionFor(app.name, repoView)} owner={member.role === "owner"} canAct={act} now={now} />
            </div>
          )}
          {member.role === "owner" && DevNotes && <div className="mt-4"><DevNotes appId={app.id} /></div>}
          {recs && (recs.length > 0 || aiNotes) && (
            <div className="mt-4"><Recommendations items={recs} canDismiss={act} showSubject={false} hideWhenEmpty notes={aiNotes} /></div>
          )}
        </TabsContent>

        <TabsContent value="metrics" keepMounted>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-3">
              <Card title="Response time" meta={<>24 h · ms<Src kind="own" /></>}>
                <Sparkline
                  values={metrics.response} second={metrics.median} ticks={deployTicks(prodDeploys, metrics.first, metrics.sizeMs, metrics.response.length, 400)}
                  width={400} height={120} fluid tone={s.state === "err" ? "err" : "accent"}
                  label="Response time p95 and p50 in 30-minute steps, last 24 hours, with production deploys"
                />
              </Card>
              <Card title="Page views" meta={<>24 h<Src kind="api" /></>}>
                <PageViewsBody pv={app.pageViews} note={app.pageViewsNote} now={now} />
              </Card>
              <Card title="5xx responses" meta={<>24 h<Src kind="own" /></>}>
                <Sparkline values={metrics.errors} width={400} height={120} fluid tone="err" label="5xx responses in 30-minute steps, last 24 hours" />
              </Card>
            </div>
            <p className="text-[12.5px] text-ink-soft">
              {"Vercel's request and error metrics need a paid plan, so response time and 5xx come from our own checks and stored logs. Page views come from Vercel Web Analytics (free on Hobby up to 50k events a month), read every 30 minutes."}
            </p>
            <Card title="Uptime" flush meta={<span className="text-ink-faint">A dark notch marks a day with a production deploy</span>}>
              {app.monitors.length === 0 ? <NoMonitors /> : (
                <PlainTable
                  head={["Monitor", "Last 90 days", "Uptime"]}
                  rows={app.monitors.map((m) => ({
                    key: m.id,
                    state: m.state,
                    text: m.path,
                    row: (
                      <tr className={rowClass}>
                        <td className={cn(td, mono)}>{m.path}</td>
                        <td className={td}><UptimeBars bars={uptimeBars(app.days.get(m.id), now, BAR_DAYS, deployDays(prodDeploys))} /></td>
                        <td className={cn(td, mono)}>{pct(uptimePct(lastDays(app.days.get(m.id), now, UPTIME_DAYS)))}</td>
                      </tr>
                    ),
                  }))}
                />
              )}
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="deployments" keepMounted>
          <Card flush>
            {/* listDeployments has no 30-day window, so an empty list means no deployment at all, which the wording covers. */}
            {deploys.length === 0 ? <NoDeployments /> : <PlainTable head={DEPLOY_HEAD} rows={deploymentRows(deploys, { canAct: act, now })} />}
          </Card>
        </TabsContent>

        {member.role !== "viewer" && (
          <TabsContent value="logs">
            <Card flush><LogViewer mode="live" apps={[]} appId={app.id} initial={[]} vercelUrl={logsUrl} /></Card>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

// Metrics → Page views: the 24 h total, the unique visitors and one bar per hour, read by the collector's `pageviews` task.
// Three states: not read yet, Web Analytics off for the project (with the two steps that turn it on), and on (0 views is
// shown as 0, not as an empty state).
function PageViewsBody({ pv, note, now }: { pv: PageViewsView | null; note: string | null; now: Date }) {
  // `note` says why the collector can never read this app, so the card doesn't wait for a read that won't come.
  if (!pv) return <p className="grid h-[120px] place-items-center text-center text-[12.5px] text-ink-soft">{note ?? "Reading page views…"}</p>;
  if (!pv.enabled) {
    return (
      <div className="flex min-h-[120px] flex-col gap-1.5 text-[12.5px] text-ink-soft">
        <p className="text-[13px] text-ink">Web Analytics is off for this project.</p>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Enable Web Analytics in the Vercel project (Analytics tab).</li>
          <li>Add <code className="font-mono text-[12px] text-ink">{"<Analytics />"}</code> from <code className="font-mono text-[12px] text-ink">@vercel/analytics</code> to the app&apos;s root layout and redeploy.</li>
        </ol>
        <p className="mt-auto text-ink-faint">Free on Hobby up to 50k events a month.</p>
      </div>
    );
  }
  return (
    <>
      <p className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[22px] font-semibold tracking-[-0.02em]">{pv.total.toLocaleString("en-US")}</span>
        <span className="text-[12.5px] text-ink-soft">{pv.total === 1 ? "view" : "views"} · {pv.visitors === null ? "—" : pv.visitors.toLocaleString("en-US")} {pv.visitors === 1 ? "visitor" : "visitors"}</span>
        {isStale(pv.readAt, now) && <span className="ml-auto text-[12px] text-ink-faint">Read {ago(pv.readAt, now)}</span>}
      </p>
      <HourBars hours={pv.hours} height={80} label={`Page views per hour, last 24 hours: ${pv.total} views from ${pv.visitors ?? "an unknown number of"} visitors`} />
    </>
  );
}

// Details → Security: the Next.js version read from the live site and its OSV.dev advisories (mockup). The page only
// reads ops.app_security; the daily job and Check now write it.
function SecurityCard({ app, security, canAct: act, now, eol }: { app: { id: string; name: string }; security: SecurityRow | null; canAct: boolean; now: Date; eol: EolData | null }) {
  const note = securityNote(security);
  return (
    <Card title="Security" meta={<><Src kind="own" />{act && <SecurityCheckButton appId={app.id} appName={app.name} />}</>} flush>
      <div className="px-[18px] pb-4 pt-2">
        <dl className={KV}>
          <dt>Next.js</dt>
          <dd>
            {security?.version ? <span className={mono}>{security.version}</span>
              : security?.status === "unknown" ? <>— <span className="text-ink-faint">{security.reason}</span></> : "—"}
          </dd>
          <dt>End of life <Src kind="api">endoflife.date</Src></dt>
          <dd><EolRow version={security?.version ?? null} eol={eol} now={now} /></dd>
          <dt>Checked</dt><dd>{security ? ago(security.checkedAt, now) : "—"}</dd>
        </dl>
        {note && (
          <p className={cn("mt-3 flex items-start gap-1.5", note.state !== "ok" && "text-ink-soft")}>
            {/* Mockup: the clean line carries the ok icon, a failed check the warning icon; the others are muted text. */}
            {(note.state === "ok" || note.state === "warn") && <StateIcon state={note.state} />}<span>{note.text}</span>
          </p>
        )}
      </div>
      {isVulnerable(security) && (
        <PlainTable
          head={["ID", "Severity", "Summary", "Fix"]}
          rows={security.findings.map((f) => ({
            key: f.id,
            state: f.severity,
            text: [f.id, f.cve, f.summary].join(" "),
            row: (
              <tr className={rowClass}>
                <td className={td}>
                  <a href={`https://osv.dev/vulnerability/${encodeURIComponent(f.id)}`} target="_blank" rel="noopener" className={mono}>{f.id}</a>
                  {f.cve && <div className={cn(mono, "mt-0.5 text-xs text-ink-faint")}>{f.cve}</div>}
                </td>
                <td className={td}><SevTag severity={f.severity} /></td>
                <td className={cn(td, tdWrap)}>{f.summary || <span className="text-ink-faint">No summary</span>}</td>
                <td className={cn(td, mono)}>{f.fixed ? `Fixed in ${f.fixed}` : <span className="text-ink-faint">No fix yet</span>}</td>
              </tr>
            ),
          }))}
        />
      )}
    </Card>
  );
}

// The page reads the repositories once (appRepoView); the suggestion needs the app's name, known only after getApp.
function suggestionFor(appName: string, view: AppRepoView): AppRepoView["suggestion"] {
  const s = suggestRepo(appName, view.repos);
  return s ? { ...s, fullName: view.repos.find((r) => r.id === s.repoId)!.fullName } : null;
}

// Details → Repository (stage 7, B7): the GitHub repository linked to the app and its latest Actions run on the default
// branch. Every role sees it; Operators refresh the run; the Owner links, changes or unlinks (console rows only).
function RepositoryCard({ app, view, suggestion, owner, canAct, now }: {
  app: { id: string; name: string }; view: AppRepoView; suggestion: AppRepoView["suggestion"]; owner: boolean; canAct: boolean; now: Date;
}) {
  const repo = view.link?.repo ?? null;
  const status = repo ? actionsStatus(repo.actions, repo.defaultBranch) : null;
  const run = repo?.actions && !("none" in repo.actions) ? repo.actions : null;
  return (
    <Card title="Repository" meta={<><Src kind="api">GitHub</Src>{repo && canAct && view.connected && <RefreshActionsButton appId={app.id} />}</>}>
      {repo ? (
        <dl className={KV}>
          <dt>Repository</dt>
          <dd>
            <ExternalLink href={repo.htmlUrl ?? `https://github.com/${repo.fullName}`} target="_blank" rel="noopener" className={mono}><Masked kind="repo" real={repo.fullName} /></ExternalLink>
            <span className="text-ink-faint"> · {repo.private ? "private" : "public"}{repo.archived ? " · archived" : ""}{repo.goneAt ? " · no longer shared with the token" : ""}</span>
            {owner && view.connected && <> <RepoDialog app={app} options={view.options} current={repo.id} suggested={null} label="Change" /></>}
          </dd>
          <dt>Linked</dt><dd className="text-ink-soft">{linkSourceText(view.link!.source)}</dd>
          <dt>Default branch</dt><dd className={mono}>{repo.defaultBranch ?? "—"}</dd>
          <dt>Last push</dt><dd>{repo.pushedAt ? ago(repo.pushedAt, now) : "—"}</dd>
          <dt>GitHub Actions</dt>
          <dd>
            <Status state={status!.state}>{status!.label}</Status>
            {run && <span className="text-ink-soft"> · {run.name ?? "workflow"}{run.runNumber ? ` #${run.runNumber}` : ""}{run.sha ? <> · <span className={mono}>{shortSha(run.sha)}</span></> : null}{run.at ? ` · ${ago(new Date(run.at), now)}` : ""}</span>}
            {run?.url && outboundLinks() && <> · <a href={run.url} target="_blank" rel="noopener">Open run <IconExternalLink size={13} aria-hidden className="inline align-[-2px]" /></a></>}
            {repo.actionsCheckedAt && <span className="block text-[12px] text-ink-faint">Read {ago(repo.actionsCheckedAt, now)}</span>}
          </dd>
        </dl>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-ink-soft">
          {suggestion ? (
            <>
              <span>Suggested: <span className={mono}><Masked kind="repo" real={suggestion.fullName} /></span> ({suggestionWhy(suggestion.why)}).</span>
              {owner && <ConfirmRepo appId={app.id} repoId={suggestion.repoId} fullName={suggestion.fullName} />}
            </>
          ) : (
            <span>No repository linked. {view.options.length ? "None matches the app's name." : "Sync GitHub on Connections to list your repositories."}</span>
          )}
          {owner && view.options.length > 0 && <RepoDialog app={app} options={view.options} current={null} suggested={suggestion?.repoId ?? null} label="Choose…" />}
        </div>
      )}
    </Card>
  );
}

// Security → End of life (R1): the Next.js major's support window from endoflife.date, read daily. Unknown is never
// shown as supported.
function EolRow({ version, eol, now }: { version: string | null; eol: EolData | null; now: Date }) {
  const e = eolLine(version, eol, now);
  if (e.state === "unknown") return <span className="text-ink-faint">{e.text}</span>;
  return <><Status state={e.state}>{e.text}</Status>{e.note && <span className="text-ink-faint"> · {e.note}</span>}</>;
}
