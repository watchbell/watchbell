import { IconExternalLink } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, PageHeader, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { Status } from "@/components/status";
import { rowClass, td, tableClass, TableHead, tdWrap } from "@/components/table";
import { canMonitor, CATALOG_SOURCES, CHECKED_ON, FREE_DBS, NOT_FREE, PICKS } from "@/data/free-databases";
import { requirePageMember } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { UsageOverview } from "./usage-overview";

// Mockup catalog(): hosted databases with a free plan, what the console can monitor for each, and the ones that
// stopped being free. Every role reads it; Connect (to Connections) is the Owner's.
export default async function CatalogPage() {
  const member = await requirePageMember();
  const owner = member.role === "owner";
  const faint = "text-[12px] text-ink-faint";
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Database" }, { label: "Free databases" }]}
        title="Free databases"
        sub={`Hosted databases you can use for free today (checked ${CHECKED_ON} against official pricing pages), and what the console can monitor for each.`}
      />
      {/* Stage 12: how much of each free plan the watched databases use. */}
      <UsageOverview />
      <div className="grid grid-cols-1 gap-4 min-[721px]:grid-cols-2 min-[1101px]:grid-cols-4">
        {PICKS.map(([need, best, also]) => (
          <Card key={need} title={need}>
            <span className="text-[20px] font-semibold tracking-[-0.02em]">{best}</span>
            <p className="mt-1 text-[12.5px] text-ink-soft">Also good: {also}</p>
          </Card>
        ))}
      </div>
      <Card flush>
        <ListFilter
          placeholder="Filter by name or type"
          states={[["yes", "Console can monitor"], ["no", "Pricing link only"]]}
          head={["Provider", "Type", "Free limits", "Sleeps or expires", "Fit", "Console can monitor", ""]}
          rows={FREE_DBS.map((d) => ({
            key: d.name,
            state: canMonitor(d) ? "yes" : "no",
            text: [d.name, d.type, d.pick, d.limits].join(" "),
            row: (
              <tr className={rowClass}>
                <td className={td}><b className="font-medium">{d.name}</b><div className={faint}>{d.pick}</div></td>
                <td className={cn(td, tdWrap)}>{d.type}</td>
                <td className={cn(td, tdWrap, "text-ink-soft")}>{d.limits}{d.checked && <div className={faint}>checked {d.checked}</div>}</td>
                <td className={cn(td, tdWrap)}>{d.sleep}</td>
                <td className={cn(td, tdWrap, "text-[13px]")}><div>Card: {d.card}</div><div>Asia: {d.asia}</div><div>Drizzle: {d.drizzle}</div></td>
                <td className={cn(td, tdWrap)}><Status state={canMonitor(d) ? "ok" : "off"}>{d.monitor}</Status></td>
                <td className={td}>
                  <div className="flex items-center gap-1.5">
                    {d.adapter === "built" && owner && <Link href="/connections" className={buttonClass({ size: "sm" })}>Connect</Link>}
                    {d.adapter === "built" && !owner && <Tag>Supported</Tag>}
                    {d.adapter === "planned" && <Tag>Adapter planned</Tag>}
                    {d.adapter !== "built" && (
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className={buttonClass({ size: "sm" })}>Pricing <IconExternalLink size={13} aria-hidden /></a>
                    )}
                  </div>
                </td>
              </tr>
            ),
          }))}
        />
      </Card>
      {/* Stage 8: where every free-plan number the console shows was read. */}
      <Card title={`As checked on ${CHECKED_ON}`} meta="Official pages">
        <p className="text-[12.5px] text-ink-soft">
          {CATALOG_SOURCES.map(([name, url], i) => (
            <span key={name}>{i > 0 && " · "}<a href={url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{name}</a></span>
          ))}
        </p>
      </Card>
      <Card title="No longer free, or not worth it" flush>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <TableHead head={["Provider", "Why"]} />
            <tbody>
              {NOT_FREE.map(([name, why]) => (
                <tr key={name} className={rowClass}>
                  <td className={td}><b className="font-medium">{name}</b></td>
                  <td className={cn(td, tdWrap, "text-ink-soft")}>{why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
