import Link from "next/link";
import { NoApps } from "@/components/empty-states";
import { Banner, buttonClass, Card, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { RefreshButton } from "@/components/refresh-button";
import { PlainTable } from "@/components/plain-table";
import { Recommendations } from "@/components/recommendations";
import { extensions } from "@/lib/extensions";
import { requirePageMember } from "@/lib/auth";
import { PendingCreates } from "@/components/create/pending-creates";
import { listRecommendations } from "@/lib/data/advisor-db";
import { listApps } from "@/lib/data/apps-db";
import { ongoingBuilds } from "@/lib/data/deployments-db";
import { aliasBook, listDatabases, listDomains, supabaseSlotInputs } from "@/lib/data/cached";
import { listEvents } from "@/lib/data/events-db";
import { poolUsage } from "@/lib/data/pool-guard";
import { DEMO_COLLECTOR_TEXT } from "@/lib/collector/status";
import { isCloud, isDemo } from "@/lib/mode";
import { PoolCard } from "@/components/pool-card";
import { health } from "@/lib/data/metrics-db";
import { brokenAccounts, lastMinuteRun } from "@/lib/data/overview-db";
import { dbBanners, firebaseCell, neonCell, slotCards, supabaseCell, supabaseRows } from "@/lib/view/databases";
import { hideEvent, hideRec } from "@/lib/view/display-name";
import { appStatus, canAct, collectorCell, credentialBanner, monitorStatus, problemBanners, vercelCell } from "@/lib/view/labels";
import { cloudflareCell } from "@/lib/view/network";
import { securityBanners } from "@/lib/view/security";
import { overviewSummary } from "@/lib/view/overview-summary";
import { PAGE_ROWS } from "@/lib/view/windows";
import { appHead, appListRows } from "../apps/app-table";
import { ActivityCard } from "./activity-card";
import { HealthCard } from "./health-card";
import { InventoryCard } from "./inventory-card";
import { StatusStrip } from "./status-strip";

// "Refresh now" runs the collector inside this page's server action; approving a Firebase create (Stage 6) polls
// Google's operations, up to about 35 s.
export const maxDuration = 60;

export default async function OverviewPage() {
  const member = await requirePageMember();
  const now = new Date();
  const act = canAct(member.role);
  // 5c slots (R2: owner only): the AI summary and the agents' AI notes on the Recommendations card.
  const owner = member.role === "owner";
  const { RecSummarySlot: RecSummary, AiNotesSlot: AiNotes } = extensions;
  // Independent reads, started together (task 12 M1). This cuts latency, not database work.
  // The Advisor is a side card: if its row can't be read the card is left out instead of failing Overview (null).
  const [apps, h, events, builds, run, broken, supa, neon, fire, slotInputs, domains, stored, book, pool] = await Promise.all([
    listApps(now), health(now), listEvents(PAGE_ROWS.recentEvents, { excludeActions: true }), ongoingBuilds(now), lastMinuteRun(), brokenAccounts(),
    listDatabases("supabase_project"), listDatabases("neon_project"), listDatabases("firestore"), supabaseSlotInputs(), listDomains(),
    listRecommendations(now).catch(() => null), aliasBook(), isCloud() ? poolUsage() : Promise.resolve(null),
  ]);
  // Privacy: databases by alias, no emails, in every text this page shows (lib/view/display-name.ts).
  const recent = events.map((e) => hideEvent(e, book));
  const recs = stored && stored.map((r) => hideRec(r, book));
  const appStates = apps.map((a) => appStatus(a).state);
  const monitorStates = apps.flatMap((a) => a.monitors.map((m) => ({ ...m, appGone: a.gone }))).map((m) => monitorStatus(m).state);
  const supaView = supabaseRows(supa, now, book);
  const dbStates = [...supa, ...neon, ...fire].map((d) => d.state);
  const dbWarnings = dbBanners(supaView, slotCards(slotInputs), book);
  const cred = credentialBanner(broken, member.role);
  const banners = problemBanners(apps.map((a) => ({
    id: a.id, name: a.name, state: a.state, gone: a.gone, since: a.stateSince, monitors: a.monitors, lastDeploy: a.lastDeploy, dbPaused: a.dbPaused,
  })), now);
  const vulnerable = securityBanners(apps.map((a) => ({ id: a.id, name: a.name, gone: a.gone, security: a.security })));
  // 1.2.3 (UI audit C2): the answer to "is everything OK?" in one sentence, from what this page shows below.
  const summary = overviewSummary(apps.filter((a) => !a.gone).map((a) => appStatus(a).state), banners.length + dbWarnings.length + vulnerable.length + (cred ? 1 : 0));

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader crumbs={[{ label: "Home" }, { label: "Overview" }]} title="Overview" sub={summary ?? undefined} actions={act ? <RefreshButton /> : undefined} />
      <StatusStrip vercel={vercelCell(appStates)} supabase={supabaseCell(supa, now)} neon={neonCell(neon, now, book)} firebase={firebaseCell(fire, now)} cloudflare={cloudflareCell(domains)} collector={isDemo() ? { state: "ok", sub: DEMO_COLLECTOR_TEXT } : collectorCell(run, now)} />
      {cred && (
        <Banner tone="danger" title={cred.title} action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
          {cred.body}
        </Banner>
      )}
      {/* Stage 6 create requests: every create waiting for the owner's approval (each type's page lists its own too). */}
      <PendingCreates member={member} waitingOnly title="Creates waiting for approval" />
      {/* "Open app" and "View deployment" are navigation, not actions, so Viewers get them too (final review M6). */}
      {banners.map((b) => (
        <Banner key={b.key} tone={b.tone} title={b.title} action={<Link href={b.action.href} className={buttonClass({ size: "sm" })}>{b.action.label}</Link>}>
          {b.body}
        </Banner>
      ))}
      {/* A paused Supabase project: one warning each, after the app banners. "Open Supabase" is a link, so every role sees it. */}
      {dbWarnings.map((b) => (
        <Banner key={b.key} tone={b.tone} title={b.title} action={<Link href={b.action.href} className={buttonClass({ size: "sm" })}>{b.action.label}</Link>}>
          {b.body}
        </Banner>
      ))}
      {/* Next.js security check: after the down/degraded banners. "Open app" is a link, so every role sees it. */}
      {vulnerable.map((b) => (
        <Banner key={b.key} tone={b.tone} title={b.title} action={<Link href={b.action.href} className={buttonClass({ size: "sm" })}>{b.action.label}</Link>}>
          {b.body}
        </Banner>
      ))}
      <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <HealthCard health={h} />
          {pool && <PoolCard pool={pool} owner={owner} compact />}
          <InventoryCard apps={appStates} databases={dbStates} monitors={monitorStates} domains={domains.map((d) => d.state)} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ActivityCard builds={builds} events={recent} now={now} />
          {recs && <Recommendations items={recs} canDismiss={act} showSubject max={10} summary={owner && RecSummary ? <RecSummary count={recs.length} /> : null} notes={owner && AiNotes ? <AiNotes /> : null} />}
        </div>
      </div>
      <Card title="Applications" meta={<Link href="/apps">View all</Link>} flush>
        {apps.length === 0
          ? <NoApps owner={member.role === "owner"} />
          : <PlainTable head={appHead(true)} rows={appListRows(apps, { compact: true, canAct: act, now, book })} />}
      </Card>
    </>
  );
}
