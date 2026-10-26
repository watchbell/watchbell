import { BellMark } from "@/components/brand/bell-mark";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { cache } from "react";
import { UptimeBars } from "@/components/charts";
import { StateIcon, Status } from "@/components/status";
import { publicView } from "@/lib/data/public-status-db";
import { overallLine, parseSlug } from "@/lib/public-status";
import { zoneName } from "@/lib/time";

// U6: the console's only page without sign-in. Rendered on first visit, then served from the cache and regenerated at
// most once a minute (ISR), so a crawler costs at most one database read a minute. No cookies(), headers() or
// searchParams anywhere in this tree, or it turns dynamic (src/app/s/public-static.test.ts). Outside the (console)
// group: no shell, no session, no screenshot-mode masking (it shows only names the owner typed for the public, B1).
export const revalidate = 60;
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ slug: string }> };

// generateMetadata and the page share one read per render.
const view = cache(async (raw: string) => {
  const slug = parseSlug(raw);
  return slug ? publicView(slug, new Date()) : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const v = await view((await params).slug);
  return { title: v ? v.title : "No status page here", robots: { index: false, follow: false } };
}

function Notice({ state, title, children }: { state: "info" | "maint"; title: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-brand/25 bg-brand-soft px-3.5 py-2.5" role="status">
      <span className="mt-px"><StateIcon state={state} size={18} /></span>
      <div>
        <b className="block font-medium">{title}</b>
        {children && <p className="mt-0.5 text-[13px] text-ink-soft">{children}</p>}
      </div>
    </div>
  );
}

export default async function PublicStatusPage({ params }: Props) {
  const { slug } = await params;
  const v = await view(slug);
  if (!v) notFound();
  const overall = overallLine(v.monitors);
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pb-12 pt-8">
      <header className="flex items-center gap-3">
        <BellMark />
        <div className="min-w-0">
          <h1 className="text-[20px]">{v.title}</h1>
          <p className="mt-0.5 text-ink-soft">Updated every minute · times in {zoneName()}</p>
        </div>
      </header>
      {overall && (
        <p className="m-0 flex items-center gap-2 text-[17px] font-medium" role="status">
          <StateIcon state={overall.state} size={20} />{overall.text}
        </p>
      )}
      {v.announcement && <Notice state="info" title={v.announcement} />}
      {v.maintenance.map((m, i) => (
        <Notice key={i} state="maint" title={m.active ? "Maintenance now" : "Scheduled maintenance"}>
          {`${m.from}–${m.to} ${zoneName()}.`}{m.note && ` ${m.note}`}
        </Notice>
      ))}
      <section className="min-w-0 rounded-lg border border-line bg-surface">
        {v.monitors.length === 0 && <p className="px-[18px] py-4 text-ink-soft">No services on this page yet.</p>}
        {v.monitors.map((m) => (
          <div key={m.badge} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-line px-[18px] py-3 first:border-t-0">
            <b className="min-w-0 truncate font-medium">{m.name}</b>
            <span className="inline-flex items-center gap-2">
              <Status state={m.state}>{m.label}</Status>
              <span className="font-mono text-[12.5px] text-ink-faint">{m.uptime}</span>
            </span>
            <div className="col-span-full min-w-0 overflow-x-auto">
              <UptimeBars bars={m.bars.map((b, i) => ({ day: String(i), tone: b.tone, title: b.title }))} />
            </div>
          </div>
        ))}
      </section>
      <p className="m-0 text-[12.5px] text-ink-faint">Last 90 days. Grey means no data, blue means maintenance (not counted).</p>
    </main>
  );
}
