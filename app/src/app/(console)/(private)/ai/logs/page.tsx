import Link from "next/link";
import { AutoRefresh } from "@/components/live";
import { Button, buttonClass, Card, EmptyState, fieldClass, PageHeader } from "@/components/kit";
import { Status } from "@/components/status";
import { TableHead, td, tableClass } from "@/components/table";
import { cn } from "@/lib/utils";
import { keyOptions, usageLog } from "@/private/ai/views-db";
import { fmtLatency, fmtTokens, logTime, logTone, modelOrTool } from "@/private/ui/view";
import { ExportButton } from "./export-button";
import { logQuery, parseLogParams, type SearchParams } from "./filter";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";

const STATE: Record<"ok" | "warn" | "err", "ok" | "warn" | "err"> = { ok: "ok", warn: "warn", err: "err" };

export default async function LogsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const sp = await searchParams;
  const { filter, page } = parseLogParams(sp);
  const now = new Date();
  const [log, keys] = await Promise.all([usageLog(filter, page), keyOptions().catch(() => [])]);
  const filtered = Object.keys(filter).length > 0;
  const prev = `/ai/logs${logQuery(filter, page - 1)}`;
  const next = `/ai/logs${logQuery(filter, page + 1)}`;

  return (
    <>
      {page === 1 && <AutoRefresh at={now.getTime()} />}
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway", href: "/ai" }, { label: "Logs" }]}
        title="Logs"
        sub="Metadata only: time, key, client, model, tokens, latency and result. Prompts and completions are never stored. Kept 30 days."
        actions={<ExportButton params={sp} />}
      />
      <Card flush>
        <form method="get" action="/ai/logs" className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pt-3.5 max-[720px]:px-3.5">
          <select name="key" className={cn(fieldClass, "w-auto")} aria-label="Key" defaultValue={filter.keyId ?? ""}>
            <option value="">All keys</option>
            {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <select name="status" className={cn(fieldClass, "w-auto")} aria-label="Result" defaultValue={filter.status ?? ""}>
            <option value="">All results</option>
            <option value="ok">Success</option>
            <option value="limit">Limit (429)</option>
            <option value="error">Error</option>
          </select>
          <input name="client" className={cn(fieldClass, "w-[170px]")} placeholder="Client" aria-label="Client" defaultValue={filter.client ?? ""} />
          <input name="model" className={cn(fieldClass, "w-[200px]")} placeholder="Model or tool" aria-label="Model or tool" defaultValue={filter.model ?? ""} />
          <Button type="submit" variant="primary">Filter</Button>
          {filtered && <Link href="/ai/logs" className={buttonClass({ variant: "ghost" })}>Clear</Link>}
          <span role="status" className="ml-auto text-[12.5px] text-ink-soft">{log.rows.length === 0 ? "No calls" : `Page ${log.page} · ${log.rows.length} call${log.rows.length === 1 ? "" : "s"}`}</span>
        </form>
        {log.rows.length === 0 ? (
          <EmptyState title={filtered ? "No calls match these filters" : "No calls yet"}>
            {filtered ? "Try a wider filter." : "Calls with a console key show up here, newest first, as soon as they happen."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={["Time", "Key", "Client", "Model / tool", "Tokens in / out", "Latency", "Result", "Error class"]} />
              <tbody>
                {log.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-hover">
                    <td className={`${td} font-mono`}>{logTime(r.at, now)}</td>
                    <td className={td}>{r.keyName ?? <span className="text-ink-faint">(console)</span>}</td>
                    <td className={`${td} font-mono text-xs`}>{r.client ?? "—"}</td>
                    <td className={`${td} font-mono text-xs`}>{modelOrTool(r)}</td>
                    <td className={`${td} font-mono`}>{fmtTokens(r.tokensIn, r.tokensOut)}</td>
                    <td className={`${td} font-mono`}>{fmtLatency(r.latencyMs)}</td>
                    <td className={td}><Status state={STATE[logTone(r.status)]}>{r.status}{r.stream ? " · stream" : ""}</Status></td>
                    <td className={`${td} font-mono text-xs text-ink-faint`}>{r.errorClass ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(page > 1 || log.hasMore) && (
          <div className="flex items-center gap-2 border-t border-line px-[18px] py-2.5 text-[12.5px] text-ink-soft">
            <span>Page {log.page}</span>
            <span className="ml-auto flex gap-1.5">
              {page > 1 ? <Link href={prev} className={buttonClass({ size: "sm" })}>‹ Previous</Link> : null}
              {log.hasMore ? <Link href={next} className={buttonClass({ size: "sm" })}>Next ›</Link> : null}
            </span>
          </div>
        )}
      </Card>
    </>
  );
}
