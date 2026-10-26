import Link from "next/link";
import { Card, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { monitorCounts, sectionState } from "@/lib/data/sections-db";
import { SECTION_IDS, SECTION_PROVIDER_NAMES, SECTIONS, type SectionId, SWITCHABLE } from "@/lib/sections";
import { SectionSwitch, type SwitchState } from "./section-switch";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// Manage › Sections (Watchbell 1.2, spec §4 and §6): each section with a switch that shows its real state and one line
// of what it holds. Owner only. An automatic section that isn't there yet shows off and disabled, with what makes it
// appear; one turned off by hand shows off and can be turned on.
export default async function SectionsPage() {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const [state, counts] = await Promise.all([sectionState(), monitorCounts().catch(() => null)]);
  const available = new Set(state.available);
  const off = new Set(state.off);
  const stateOf = (id: SectionId): SwitchState => (off.has(id) ? "off" : available.has(id) ? "on" : "waiting");
  // Turning Hosting off stops every uptime check and heartbeat: the confirm step names them.
  const stops: Partial<Record<SectionId, string>> = {
    hosting: counts
      ? `This stops all uptime checks and heartbeats (${plural(counts.http, "uptime check")}, ${plural(counts.heartbeat, "heartbeat")}), and pauses the Vercel and Cloudflare sync with their deployment, domain and certificate alerts, until you turn Hosting on again. Nothing is deleted.`
      : "This stops all uptime checks and heartbeats, and pauses the Vercel and Cloudflare sync with their deployment, domain and certificate alerts, until you turn Hosting on again. Nothing is deleted.",
    database: "Database pages are hidden and their sync, alerts and auto-actions pause. Keep active and Auto-restore keep running.",
    devops: "DevOps pages are hidden and the GitHub sync, dependency scans, their alerts and auto-actions pause.",
  };
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "Sections" }]}
        title="Sections"
        sub="Turn a section off to hide it and pause its sync, alerts and auto-actions. Nothing is deleted."
        more="The menu is grouped into sections. Hosting is there from the start; Database and DevOps appear by themselves when you connect a provider that belongs to them. Turning a section back on picks up where it left off."
      />
      <Card title="Sections" flush>
        <ul className="border-t border-line">
          {SECTION_IDS.map((id) => {
            const s = SWITCHABLE.includes(id) ? stateOf(id) : null;
            return (
              <li key={id} className="flex items-center gap-4 border-b border-line px-[18px] py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <b className="font-medium">{SECTIONS[id].label}</b>
                  <p className="mt-0.5 text-[13px] text-ink-soft">{SECTIONS[id].holds}</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-faint">
                    {s === null && "Always on."}
                    {s === "on" && "On."}
                    {s === "off" && "Off: hidden from the menu; its sync, alerts and auto-actions are paused. Its data is kept."}
                    {s === "waiting" && <>Appears when you connect {SECTION_PROVIDER_NAMES[id]} in <Link href="/connections">Connections</Link>.</>}
                    {SECTIONS[id].keeps && <> {SECTIONS[id].keeps}</>}
                  </p>
                </div>
                {s === null
                  ? <span className="text-[12.5px] text-ink-faint">Always on</span>
                  : <SectionSwitch section={id} label={SECTIONS[id].label} state={s} stops={stops[id] ?? ""} />}
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
