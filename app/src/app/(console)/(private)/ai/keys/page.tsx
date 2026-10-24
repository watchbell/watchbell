import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { NoAccess } from "@/components/no-access";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td } from "@/components/table";
import { pageGate } from "@/lib/auth";
import { listKeys, listProviderOptions } from "@/private/keys/keys-db";
import { ScopeChips } from "@/private/keys/scope-chips";
import { SCOPE_INFO, SCOPES } from "@/private/keys/scopes";
import { KEY_FILTER_STATES, keyView } from "@/private/keys/view";
import { CreateKeyDialog } from "./create-key-dialog";
import { KeyActions } from "./key-actions";

const HEAD = ["Name", "Key", "Scopes", "Rate limit", "Created", "Expires", "Last used", "Detected clients", "Status", ""];

export default async function KeysPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const [keys, providers] = await Promise.all([listKeys(), listProviderOptions()]);

  const rows: ListRow[] = keys.map((k) => {
    const v = keyView(k, now);
    return {
      key: k.id,
      state: v.state,
      text: [k.name, k.prefix, k.scopes.join(" "), k.clients.join(" "), v.label].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}><b className="font-medium">{k.name}</b></td>
          <td className={`${td} font-mono text-[12.5px]`}>{k.prefix}…</td>
          <td className={td}><ScopeChips scopes={k.scopes} /></td>
          <td className={`${td} font-mono text-[12.5px]`}>{k.ratePerMin} / min</td>
          <td className={`${td} text-ink-soft`}>{v.created}</td>
          <td className={`${td} text-ink-soft`}>{v.expires}</td>
          <td className={`${td} text-ink-soft`}>{v.lastUsed}</td>
          <td className={`${td} text-ink-soft`}>
            {k.clients.length
              ? k.clients.map((c, i) => <span key={c}>{i > 0 && ", "}<Link href="/ai/agents" className="text-brand">{c}</Link></span>)
              : <span className="text-ink-faint">None yet</span>}
          </td>
          <td className={td}><Status state={v.state}>{v.label}</Status></td>
          <td className={td}>
            {v.status !== "revoked" && (
              <KeyActions
                k={{ id: k.id, name: k.name, prefix: k.prefix, ratePerMin: k.ratePerMin, expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null, providerId: k.providerId, model: k.model }}
                providers={providers}
              />
            )}
          </td>
        </tr>
      ),
    };
  });

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "AI Gateway", href: "/ai" }, { label: "API keys" }]}
        title="API keys"
        sub="Console API keys for apps and agents. A key is shown once; Watchbell keeps only its SHA-256 hash. Revoking stops it within a minute."
        actions={<CreateKeyDialog />}
      />
      <Card flush>
        {keys.length === 0
          ? <EmptyState title="No API keys yet">Create one for each app or agent, named after it, with the button at the top.</EmptyState>
          : <ListFilter placeholder="Filter keys" states={KEY_FILTER_STATES} head={HEAD} rows={rows} />}
      </Card>
      <Card title="Scopes">
        <dl className="grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1">
          {SCOPES.map((s) => (
            <div key={s} className="contents">
              <dt className="text-ink-soft"><ScopeChips scopes={[s]} /></dt>
              <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{SCOPE_INFO[s].long}</dd>
            </div>
          ))}
          <dt className="font-mono text-xs text-ink-faint">read:*</dt>
          <dd className="m-0 text-ink-soft">Later: more read-only data.</dd>
        </dl>
      </Card>
    </>
  );
}
