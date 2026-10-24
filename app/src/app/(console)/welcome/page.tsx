import { IconCheck } from "@tabler/icons-react";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { buttonClass, Card, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { WELCOME_COPY } from "@/lib/copy/edition";
import { AccountDialog } from "../connections/account-dialog";
import { SyncButton } from "../connections/sync-dialog";
import { hideEmails } from "@/lib/view/display-name";

function Step({ n, title, body, done, children }: { n: number; title: string; body: string; done?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3.5 border-t border-line px-[18px] py-3.5 first:border-t-0">
      <span className={`grid size-[26px] shrink-0 place-items-center rounded-full border font-mono text-xs font-medium ${done ? "border-transparent bg-ok-soft text-ok" : "border-line-strong"}`}>{done ? <IconCheck size={14} aria-label="Done" /> : n}</span>
      <div className="flex-1">
        <h3 className="text-sm">{title}</h3>
        <p className="mb-2 mt-0.5 text-[13px] text-ink-soft">{body}</p>
        <div className="flex flex-wrap gap-2">{children}</div>
      </div>
    </div>
  );
}

export default async function WelcomePage() {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  // Three independent reads, sent together (perf P4).
  const [providers, vercels, watched] = await Promise.all([
    db().select({ p: accounts.provider }).from(accounts),
    db().select({ id: accounts.id, label: accounts.label, watchNew: accounts.watchNew }).from(accounts).where(eq(accounts.provider, "vercel")).limit(1),
    db().select({ id: resources.id }).from(resources).where(eq(resources.monitored, true)).limit(1),
  ]);
  const connected = new Set<string>(providers.map((r) => r.p));
  const vercel = vercels[0];
  const watching = watched.length > 0;
  const alerts = WELCOME_COPY.alertsStep;

  return (
    <>
      <PageHeader crumbs={[{ label: "Home" }, { label: "Welcome" }]} title="Welcome to Watchbell" sub="Nothing is connected yet. These steps take about 10 minutes." />
      <div className="grid gap-4 min-[1001px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="rounded-lg border border-line bg-surface">
          <Step n={1} title="Connect Vercel" body="Paste an access token. The console lists your projects but watches nothing until you choose." done={connected.has("vercel")}>
            {connected.has("vercel") ? <Link href="/connections?provider=vercel">View connection</Link> : <AccountDialog provider="vercel" triggerLabel="Connect Vercel" primary />}
          </Step>
          <Step n={2} title="Pick the apps to watch" body="Run Sync and tick the projects you care about. Each gets an uptime check every minute." done={watching}>
            {vercel ? <SyncButton accountId={vercel.id} title={`Vercel · ${hideEmails(vercel.label)}`} label="Sync Vercel" primary watchNew={vercel.watchNew} /> : <span className="text-[12.5px] text-ink-faint">Connect Vercel first</span>}
          </Step>
          <Step n={3} title="Add your databases" body="Connect one or more accounts per provider. Status is read from their APIs, so your databases aren't woken up." done={["supabase", "neon", "firebase"].some((p) => connected.has(p))}>
            <AccountDialog provider="supabase" triggerLabel="Supabase" />
            <AccountDialog provider="neon" triggerLabel="Neon" />
            <AccountDialog provider="firebase" triggerLabel="Firebase" />
          </Step>
          <Step n={4} title="Add your domains (optional)" body="Connect Cloudflare to see DNS, certificates, and when domains expire." done={connected.has("cloudflare")}>
            <AccountDialog provider="cloudflare" triggerLabel="Connect Cloudflare" />
          </Step>
          <Step n={5} title="Get alerts" body="Connect a Telegram bot so you hear about problems right away.">
            {alerts.href ? <Link href={alerts.href} className={buttonClass({ size: "sm" })}>{alerts.text}</Link> : <span className="text-[12.5px] text-ink-faint">{alerts.text}</span>}
          </Step>
          <Step n={6} title="Back up to Google Drive (optional)" body="A summary of each month is saved to your Drive. The last 3 months are kept." done={connected.has("drive")}>
            <Link href="/backups" className={buttonClass({ size: "sm" })}>{connected.has("drive") ? "Open backups" : "Set up backups"}</Link>
          </Step>
        </section>
        <div className="flex flex-col gap-4">
          <Card title="What it costs">
            <span className="text-[26px] font-semibold tracking-tight">{WELCOME_COPY.amount}</span>
            <p className="mb-2.5 mt-1 text-[12.5px] text-ink-soft">{WELCOME_COPY.note}</p>
            {WELCOME_COPY.free.map(([n, d]) => (
              <div key={n} className="flex items-center gap-2 border-b border-line py-2 last:border-b-0">
                <span>{n}</span><span className="ml-auto text-[13px] text-ink-soft">{d}</span>
              </div>
            ))}
          </Card>
          <Card title="Not ready yet?">
            <p className="text-[13px] text-ink-soft">You can come back to this page any time from Home. The rest of the console fills in as you connect accounts.</p>
            <Link href="/connections" className={`${buttonClass({ size: "sm" })} mt-2`}>Open connections</Link>
          </Card>
        </div>
      </div>
    </>
  );
}
