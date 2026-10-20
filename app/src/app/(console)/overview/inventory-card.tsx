import { Card } from "@/components/kit";
import { Resource } from "@/components/resource";
import { StateIcon } from "@/components/status";
import type { State } from "@/lib/status";
import { STATE_WORD, stateCounts } from "@/lib/view/labels";

const row = "flex items-center gap-2 border-b border-line py-2 last:border-b-0";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Counts({ states }: { states: State[] }) {
  return (
    <span className="ml-auto flex gap-2.5 text-[13px]">
      {stateCounts(states).map((c) => (
        <span key={c.state} className="inline-flex items-center gap-1"><StateIcon state={c.state} /><span className="sr-only">{STATE_WORD[c.state]}</span>{c.n}</span>
      ))}
    </span>
  );
}

// Mockup section 1 → Inventory.
export function InventoryCard({ apps, databases, monitors, domains }: { apps: State[]; databases: State[]; monitors: State[]; domains: State[] }) {
  return (
    <Card title="Inventory">
      <div className={row}><Resource kind="app" name={plural(apps.length, "application")} href="/apps" /><Counts states={apps} /></div>
      <div className={row}><Resource kind="db" name={plural(databases.length, "database")} href="/supabase" /><Counts states={databases} /></div>
      <div className={row}><Resource kind="mon" name={plural(monitors.length, "monitor")} href="/uptime" /><Counts states={monitors} /></div>
      <div className={row}><Resource kind="dom" name={plural(domains.length, "domain")} href="/domains" /><Counts states={domains} /></div>
    </Card>
  );
}
