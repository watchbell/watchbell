import { Card, Progress } from "@/components/kit";
import { td, tableClass, TableHead } from "@/components/table";
import { listApps } from "@/lib/data/apps-db";
import { readBudgetLimits } from "@/lib/data/settings-db";
import { aliasBook, listDatabases, supabaseSlotInputs } from "@/lib/data/cached";
import { budgetRows } from "@/lib/view/settings";
import { neonBlocks, slotCards } from "@/lib/view/databases";
import { BudgetForm } from "./budget-form";

// Limits against what the console already reads. Where it reads nothing, the row says "not read" (or "not read yet"). Stage 7 (B6): the
// limits and the warn/alarm percentages are the Owner's to correct (Free tier limits card), audited.
export async function BudgetTab() {
  const now = new Date();
  const [inputs, neonRowsDb, book, apps, limits] = await Promise.all([supabaseSlotInputs(), listDatabases("neon_project"), aliasBook(), listApps(now), readBudgetLimits()]);
  const watched = apps.filter((a) => !a.gone);
  const rows = budgetRows({
    slots: slotCards(inputs),
    neon: neonBlocks(neonRowsDb, now, book).map((b) => ({ id: b.id, alias: b.alias, cu: b.cu })),
    apps: {
      total: watched.length,
      read: watched.filter((a) => a.pageViews !== null).length,
      enabled: watched.filter((a) => a.pageViews?.enabled === true).length,
    },
  }, limits);
  return (
    <div className="flex flex-col gap-4">
      <Card title="Free tier budget" flush meta="Everything stays on free plans">
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <TableHead head={["Item", "Free limit", "Current use"]} />
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className={td}>{r.item}</td>
                  <td className={`${td} text-ink-soft`}>{r.limit}</td>
                  <td className={td}>
                    <span className={r.use.includes("not read") ? "text-ink-soft" : "font-mono text-[12.5px]"}>{r.use}</span>
                    {r.pct !== null && <Progress pct={r.pct} tone={r.tone === "warn" || r.tone === "err" ? r.tone : undefined} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Free tier limits" meta="Correct them here when a provider changes its free plan">
        <BudgetForm saved={limits} />
      </Card>
    </div>
  );
}
