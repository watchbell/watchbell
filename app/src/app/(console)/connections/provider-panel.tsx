import type { ReactNode } from "react";
import { AccountChip } from "@/components/resource";
import { StateIcon, Status } from "@/components/status";
import { type Provider, PROVIDER_INFO } from "@/lib/providers/info";
import { SYNC_KIND } from "@/lib/sync";
import type { AccessHint } from "@/lib/view/access";
import { hideEmails } from "@/lib/view/display-name";
import { RemoveAccountButton, RetestButton } from "./account-actions";
import { AccountDialog, AccountForm } from "./account-dialog";
import { GithubSyncButton } from "./github-sync-button";
import { SyncButton } from "./sync-dialog";

// What the drawer shows per account; page.tsx reads and decrypts, this only lays it out.
export type PanelAccount = {
  id: string; label: string; credentialKind: string; scopeNote: string | null; hint: AccessHint | null;
  expires: string; lastSync: string; problem: string | null; unreadable: boolean; watchNew: boolean;
  monitored: { repos: number; linked: number } | { on: number; total: number; fresh: number } | null;
};

const HINT_STATE = { ok: "ok", off: "warn", faint: "off" } as const;

// Stage 6 A7: under the Access note, whether the console's actions work with this credential (mockup connections()).
function AccessLine({ hint }: { hint: AccessHint }) {
  return (
    <div className={`mt-0.5 flex items-start gap-1.5 text-[12px] ${hint.tone === "faint" ? "text-ink-faint" : ""}`}>
      <span className="mt-px"><StateIcon state={HINT_STATE[hint.tone]} size={14} /></span>
      <span>{hint.text}</span>
    </div>
  );
}

function Monitored({ m }: { m: PanelAccount["monitored"] }) {
  if (!m) return <span className="text-ink-faint">—</span>;
  if ("repos" in m) return <><span className="font-mono">{m.repos}</span><span className="text-ink-faint"> repos · {m.linked} linked</span></>;
  if (m.total === 0) return <span className="text-ink-faint">—</span>;
  return (
    <>
      <span className="font-mono">{m.on}</span><span className="text-ink-faint"> of {m.total}</span>
      {m.fresh > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-px font-mono text-[10.5px] text-brand">{m.fresh} new</span>}
    </>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-faint">{term}</dt>
      <dd className="text-[13px]">{children}</dd>
    </div>
  );
}

const heading = "px-[18px] pb-1 pt-4 text-[13px] font-medium text-ink-soft";

export function ProviderPanel({ provider, accounts, demo }: { provider: Provider; accounts: PanelAccount[]; demo: boolean }) {
  const info = PROVIDER_INFO[provider];
  const canAdd = info.multiAccount || accounts.length === 0;
  return (
    <>
      {accounts.length > 0 && (
        <>
          <h3 className={heading}>{accounts.length === 1 ? "Account" : `Accounts (${accounts.length})`}</h3>
          <ul className="border-b border-line">
            {accounts.map((a) => {
              const title = `${info.name} · ${hideEmails(a.label)}`;
              return (
                <li key={a.id} className="border-t border-line px-[18px] py-3 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <AccountChip name={a.label} />
                    <span className="ml-auto">{a.problem ? <Status state="err">{hideEmails(a.problem)}</Status> : <Status state="ok">{demo ? "Demo account" : "Connected"}</Status>}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 max-[520px]:grid-cols-1">
                    <Fact term="Credential">{a.credentialKind}</Fact>
                    <Fact term="Expires"><span className="text-ink-soft">{a.expires}</span></Fact>
                    <Fact term="Access">
                      <span className="text-ink-soft">{a.scopeNote}</span>
                      {a.hint && <AccessLine hint={a.hint} />}
                    </Fact>
                    <Fact term="Monitored"><Monitored m={a.monitored} /></Fact>
                    <Fact term="Last sync"><span className="text-ink-soft">{a.lastSync}</span></Fact>
                  </dl>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {!a.problem && provider !== "github_write" && (provider === "github"
                      ? <GithubSyncButton accountId={a.id} />
                      : <SyncButton accountId={a.id} title={title} watchNew={a.watchNew} kind={SYNC_KIND[provider]} />)}
                    {!a.unreadable && <RetestButton accountId={a.id} />}
                    <AccountDialog provider={provider} replace={{ id: a.id, label: a.label }} primary={a.problem !== null} />
                    <RemoveAccountButton accountId={a.id} title={title} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {canAdd ? (
        <section aria-label={accounts.length === 0 ? `Connect ${info.name}` : "Add another account"}>
          <h3 className={heading}>{accounts.length === 0 ? `Connect ${info.name}` : "Add another account"}</h3>
          <p className="px-[18px] pb-2 text-[12.5px] text-ink-soft">The credential is encrypted before it&apos;s saved and never shown again.</p>
          <AccountForm provider={provider} />
        </section>
      ) : (
        <p className="px-[18px] py-4 text-[12.5px] text-ink-soft">One {info.name} account per Watchbell. Replace its credential above, or remove it to connect a different one.</p>
      )}
    </>
  );
}
