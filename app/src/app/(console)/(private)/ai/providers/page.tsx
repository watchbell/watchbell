import Link from "next/link";
import { Banner, Card, PageHeader } from "@/components/kit";
import { Status } from "@/components/status";
import { rowClass, tableClass, td, tdWrap, TableHead } from "@/components/table";
import { type ConnectionView, listConnections, MAX_CUSTOM } from "@/private/ai/providers/providers-db";
import { PRESETS } from "@/private/ai/providers/presets";
import { DefaultProviderSelect, EnabledSwitch, ProviderMenu, TestProviderButton } from "./provider-actions";
import { ProviderDialog } from "./provider-dialog";
import { PROVIDER_ICONS } from "./provider-icons";
import { NoAccess } from "@/components/no-access";
import { isFresh, readAgSettings } from "@/private/ai/extras";
import { providersInfo } from "@/private/ui/ai-banner";
import { pageGate } from "@/lib/auth";
import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { mode } from "@/lib/mode";

// The custom provider dialog's Base URL help depends on the runtime mode (ruling Q11: self-host allows local servers).
const selfhost = () => mode() === "selfhost";

// Mockup AI_VIEWS.providers ("Bring your own key"). Owner-only through (console)/(private)/layout.tsx (R2). The page
// gets ConnectionView only: no secret, just the last 3 characters of the key (R3).

function lastTest(c: ConnectionView): string {
  if (!c.lastTestAt) return "—";
  const t = c.lastTestAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
  return `${t} · ${c.lastTestStatus === 200 ? "ok" : c.lastTestStatus ?? "—"}`;
}

function Row({ c }: { c: ConnectionView }) {
  const Icon = PROVIDER_ICONS[c.kind];
  const on = c.models.filter((m) => m.enabled).length;
  const problem = c.lastTestStatus !== null && c.lastTestStatus !== 200 ? c.lastError : null;
  return (
    <tr className={rowClass}>
      <td className={td}>
        <span className="inline-flex items-center gap-2">
          <span className="grid size-[26px] place-items-center rounded-md bg-sunken text-ink-soft"><Icon size={15} aria-hidden /></span>
          <span>
            <b className="font-medium">{c.name}</b>{c.isDefault && <span className="ml-1.5 rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">Default</span>}
            <div className="max-w-[360px] truncate font-mono text-[11.5px] text-ink-faint">{c.baseUrl}</div>
          </span>
        </span>
      </td>
      <td className={td}><span className="text-[12.5px] text-ink-soft">{c.keyHint ? <>{PRESETS[c.kind].keyLabel} <span className="font-mono">{c.keyHint}</span></> : PROVIDERS_COPY.noKey}</span></td>
      <td className={`${td} font-mono`}>{c.models.length} · {on} on</td>
      <td className={`${td} text-ink-soft`}>{lastTest(c)}</td>
      <td className={td}><EnabledSwitch id={c.id} on={c.enabled} name={c.name} /></td>
      <td className={`${td} ${problem ? tdWrap : ""}`}>{problem ? <Status state="err">{problem}</Status> : c.enabled ? <Status state="ok">Connected</Status> : <Status state="off">Off</Status>}</td>
      <td className={td}>
        <div className="flex items-center gap-1.5">
          <TestProviderButton id={c.id} />
          <ProviderDialog kind={c.kind} replace={{ id: c.id, name: c.name, baseUrl: c.baseUrl }} primary={problem !== null} selfhost={selfhost()} />
          <ProviderMenu id={c.id} name={c.name} isDefault={c.isDefault} />
        </div>
      </td>
    </tr>
  );
}

function NotConnected({ kind }: { kind: "gemini" | "cloudflare" | "custom" }) {
  const p = PRESETS[kind];
  const Icon = PROVIDER_ICONS[kind];
  return (
    <tr className={rowClass}>
      <td className={td}>
        <span className="inline-flex items-center gap-2">
          <span className="grid size-[26px] place-items-center rounded-md bg-sunken text-ink-soft"><Icon size={15} aria-hidden /></span>
          <span>
            <b className="font-medium">{p.name}</b>
            <div className="font-mono text-[11.5px] text-ink-faint">{kind === "cloudflare" ? p.baseUrl({ apiKey: "", accountId: "{account_id}" }) : kind === "custom" ? "Your base URL (…/v1)" : p.baseUrl({ apiKey: "" })}</div>
          </span>
        </span>
      </td>
      <td className={td}><span className="text-ink-faint">{p.keyLabel}{kind === "cloudflare" ? " + account ID" : kind === "custom" ? " + base URL" : ""}</span></td>
      <td className={`${td} font-mono`}>—</td>
      <td className={`${td} text-ink-soft`}>—</td>
      <td className={td} />
      <td className={td}><Status state="off">Not connected</Status></td>
      <td className={td}><ProviderDialog kind={kind} primary selfhost={selfhost()} /></td>
    </tr>
  );
}

const HEAD = ["Provider", "Key", "Models", "Last test", "Enabled", "Status", ""];

export default async function ProvidersPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const [conns, agFresh] = await Promise.all([
    listConnections(),
    readAgSettings().then(({ report }) => isFresh(report, new Date())).catch(() => false), // informational only
  ]);
  const info = providersInfo(agFresh);
  const custom = conns.filter((c) => c.kind === "custom");
  const current = conns.find((c) => c.isDefault) ?? null;
  const anyOn = conns.some((c) => c.enabled);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway", href: "/ai" }, { label: "Bring your own key" }]}
        title="Bring your own key"
        sub="OpenAI-compatible provider connections, Google models only. One is the default; a console key can be pinned to another provider or model. Keys are encrypted with AES-256-GCM, never sent to the browser, never logged. Watchbell never rotates between accounts."
      />
      {!anyOn && (
        <Banner tone="info" title={info.title}>{info.body}</Banner>
      )}
      <Card title="Provider connections" meta="OpenAI-compatible · one account per provider" flush>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <TableHead head={HEAD} />
            <tbody>
              {(["gemini", "cloudflare"] as const).map((kind) => {
                const c = conns.find((x) => x.kind === kind);
                return c ? <Row key={c.id} c={c} /> : <NotConnected key={kind} kind={kind} />;
              })}
            </tbody>
          </table>
        </div>
        <details className="border-t border-line px-[18px] py-2.5" open={custom.length > 0}>
          <summary className="cursor-pointer text-[13px] text-ink-soft">Advanced: custom OpenAI-compatible server ({custom.length} of {MAX_CUSTOM})</summary>
          <p className="mt-1.5 text-[13px] text-ink-soft">{PRESETS.custom.where.text} Models the server doesn&apos;t list can be added on <Link href="/ai/models">Models</Link>.</p>
          {custom.length > 0 && (
            <div className="-mx-[18px] mt-2 overflow-x-auto">
              <table className={tableClass}><TableHead head={HEAD} /><tbody>{custom.map((c) => <Row key={c.id} c={c} />)}</tbody></table>
            </div>
          )}
          {custom.length < MAX_CUSTOM && <div className="mt-2"><ProviderDialog kind="custom" label="Connect a custom server" selfhost={selfhost()} /></div>}
        </details>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Routing">
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-ink-soft">Default provider</dt>
            <dd><DefaultProviderSelect options={conns.map((c) => ({ id: c.id, name: c.name }))} current={current?.id ?? null} /></dd>
            <dt className="text-ink-soft">Model ids</dt>
            <dd><span className="font-mono">provider/model</span> goes to that provider. A bare id goes to the default provider.</dd>
            <dt className="text-ink-soft">Per key</dt>
            <dd>A console key can be pinned to a provider or one model (API keys › Change routing).</dd>
            <dt className="text-ink-soft">Models</dt>
            <dd>{PROVIDERS_COPY.modelsLine}</dd>
            <dt className="text-ink-soft">Failover</dt>
            <dd>None. A provider error goes back to the caller as is; Watchbell never retries on another account.</dd>
          </dl>
        </Card>
        <Card title="How keys are kept">
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-ink-soft">Stored</dt>
            <dd>Encrypted (AES-256-GCM, with key version) in the console&apos;s database. The browser sees only the last 3 characters.</dd>
            <dt className="text-ink-soft">Sent to</dt>
            <dd>Only that provider&apos;s base URL, from the server.</dd>
            <dt className="text-ink-soft">Never</dt>
            <dd>Consumer sign-ins, OAuth sessions, borrowed accounts, rotating keys for more quota.</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}
