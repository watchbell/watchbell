import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { NoAccess } from "@/components/no-access";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td, tdWrap } from "@/components/table";
import { pageGate } from "@/lib/auth";
import { AI_COPY } from "@/lib/copy/edition";
import type { State } from "@/lib/status";
import { ago, clock, dayMonth } from "@/lib/time";
import { listAgents } from "@/private/agents/agents-db";
import type { AgentStatus } from "@/private/agents/detect";
import { compactCount } from "@/private/keys/view";
import { AgentActions } from "./agent-actions";
import { AgentsRefresh } from "./agents-refresh";

const HEAD = ["Agent", "Client", "Key", "Uses", "First seen", "Last seen", "Requests 24h", "MCP calls 1h / 24h", "Tokens 24h", "Models / tools", "Status", ""];
const FILTER_STATES: [string, string][] = [["ok", "Active"], ["idle", "Idle"], ["off", "Key revoked"]];
const STATUS: Record<AgentStatus, { state: State; label: string }> = {
  active: { state: "ok", label: "Active" },
  idle: { state: "idle", label: "Idle" },
  revoked: { state: "off", label: "Key revoked" },
};
const VIA: Record<string, string> = { mcp: "MCP clientInfo", "x-client": "X-Client header", "user-agent": "User-Agent", unknown: "no client info", console: "built in" };
const mono = "font-mono text-[12.5px]";

export default async function AgentsPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const agents = await listAgents(now);

  const rows: ListRow[] = agents.map((a) => {
    const s = STATUS[a.status];
    return {
      key: a.id,
      state: s.state,
      text: [a.name, a.clientName, a.version, a.keyName ?? "", a.userAgent, a.recent.join(" "), s.label].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}>
            <b className="font-medium">{a.name}</b> <span className="font-mono text-xs text-ink-faint">{a.version}</span>
            <div className="text-xs text-ink-faint">from {VIA[a.via] ?? a.via}</div>
          </td>
          <td className={`${td} ${tdWrap} font-mono text-xs`}>{a.userAgent || "—"}</td>
          <td className={td}>{a.keyName ? <Link href="/ai/keys" className="text-brand">{a.keyName}</Link> : <span className="text-ink-faint">(no key, owner session)</span>}</td>
          <td className={`${td} text-ink-soft`}>{a.uses.length ? a.uses.join(" + ") : "—"}</td>
          <td className={`${td} text-ink-soft`}>{`${dayMonth(a.firstSeenAt)} ${clock(a.firstSeenAt)}`}</td>
          <td className={`${td} text-ink-soft`}>{ago(a.lastSeenAt, now)}</td>
          <td className={`${td} ${mono}`}>{a.requests24h}</td>
          <td className={`${td} ${mono}`}>{a.mcpCalls24h > 0 ? `${a.mcpCalls1h} / ${a.mcpCalls24h}` : "—"}</td>
          <td className={`${td} ${mono}`}>{a.tokens24h > 0 ? compactCount(a.tokens24h) : "—"}</td>
          <td className={`${td} ${tdWrap} text-[12.5px] text-ink-soft`}>{a.recent.length ? a.recent.join(", ") : "—"}</td>
          <td className={td}><Status state={s.state}>{s.label}</Status></td>
          <td className={td}><AgentActions id={a.id} name={a.name} clientName={a.clientName} keyRevoked={a.status === "revoked"} /></td>
        </tr>
      ),
    };
  });

  return (
    <>
      <AgentsRefresh />
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "AI Gateway", href: "/ai" }, { label: "Agents" }]}
        title="Agents"
        sub="Detected automatically from the first request with a key: the MCP client name, the X-Client header, or the User-Agent. Nothing to register."
      />
      <Card flush>
        {agents.length === 0
          ? <EmptyState title="No agents yet">An agent shows up here after its first request with a console key.</EmptyState>
          : <ListFilter placeholder="Filter agents" states={FILTER_STATES} head={HEAD} rows={rows} />}
        <div className="flex items-center gap-2.5 border-t border-dashed border-line-strong px-[18px] py-3 text-[13px] text-ink-soft">
          <span className="size-2 shrink-0 rounded-full bg-ok" aria-hidden />
          <span>Listening. A new agent appears here after its first request with a console key. <Link href="/ai/connect" className="text-brand">Connect an agent</Link></span>
        </div>
      </Card>
      <Card title="How an agent is detected">
        <dl className="grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1">
          <dt className="text-ink-soft">MCP clients</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">The name and version the client sends in <span className="font-mono">initialize</span> (clientInfo), for example {AI_COPY.clientExamples}.</dd>
          <dt className="text-ink-soft">HTTP callers</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">The <span className="font-mono">X-Client: name/version</span> header; without it, the first product in the User-Agent.</dd>
          <dt className="text-ink-soft">Status</dt>
          <dd className="m-0 min-w-0">Active if seen in the last 30 minutes, Idle after that, Key revoked when its key is.</dd>
          <dt className="text-ink-soft">Stored</dt>
          <dd className="m-0 min-w-0">Name, version, User-Agent (first 200 characters), counters. Never IP addresses or request bodies.</dd>
        </dl>
      </Card>
    </>
  );
}
