import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { td, tdWrap, rowClass, type ListRow } from "@/components/table";
import { AI_EXTRAS, readModelSyncState } from "@/private/ai/extras";
import { AntigravitySection, antigravityView } from "@/private/ai/extras-ui";
import { modelRows } from "@/private/ai/views-db";
import { fmtCtx } from "@/private/ui/view";
import { AddModelIdForm, RemoveManualModelButton } from "./manual-model-controls";
import { MakeDefaultButton, ModelSwitch, RefreshModelsButton, ScanAllButton, SyncNowButton, TestModelButton } from "./model-controls";
import { isNewModel, type SyncState, syncStatusText } from "@/private/ai/providers/model-sync";
import { testLabel } from "@/private/ai/providers/test-label";
import { readAdvisorSettings } from "@/private/assist/advisor-notes";
import { ALWAYS_APP } from "@/private/assist/advisor-config";
import { DEFAULT_ADVISOR_SETTINGS } from "@/private/assist/advisor-logic";
import { ports } from "@/private/assist/ports";
import { AdvisorNotesControls } from "./advisor-controls";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { zoneName } from "@/lib/time";
import { scheduleModelRefresh } from "@/private/ai/providers/refresh";

// Test / Scan all wait for the provider (4 at a time, up to ~50 s); Vercel Hobby allows 60 s.
export const maxDuration = 60;

export default async function ModelsPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  scheduleModelRefresh(); // custom servers' lists older than 10 min are re-detected after the response
  const now = new Date();
  const [{ rows, defaultModel, providers }, ag, advisor, provider, sync] = await Promise.all([
    modelRows(), antigravityView(now), readAdvisorSettings().catch(() => DEFAULT_ADVISOR_SETTINGS), ports.provider().catch(() => null),
    readModelSyncState().catch((): SyncState | null => null),
  ]);
  const customs = providers.filter((p) => p.kind === "custom");
  const list: ListRow[] = rows.map((m) => {
    const isDefault = m.publicId === defaultModel;
    const state = m.enabled && m.providerEnabled ? "ok" : "off";
    const test = m.pending && !m.lastTest ? { tone: "none" as const, text: "waiting for the sync's test" } : testLabel(m.lastTest, now);
    return {
      key: `${m.providerId}/${m.modelId}`,
      state,
      tags: test.tone === "ok" ? ["working"] : [],
      text: `${m.publicId} ${m.upstream} ${m.providerName}`,
      row: (
        <tr data-state={state} className={rowClass}>
          <td className={td}>
            <b className="font-mono text-[13px] font-medium">{m.publicId}</b>
            {isDefault && <> <Tag>Default</Tag></>}
            {m.manual && <> <Tag>manual</Tag></>}
            {m.removed && <> <Tag>removed in {m.providerName}</Tag></>}
            {!m.removed && isNewModel(m, now) && <> <Tag>new</Tag></>}
            {m.manualOff && <> <Tag>off by hand</Tag></>}
            <div className="font-mono text-xs text-ink-faint">{m.upstream}</div>
          </td>
          <td className={td}>{m.providerName}{!m.providerEnabled && <> <Tag>Connection off</Tag></>}</td>
          <td className={`${td} font-mono`}>{fmtCtx(m.ctx)}</td>
          <td className={`${td} font-mono`}>{fmtCtx(m.out)}</td>
          <td className={`${td} ${tdWrap}`}>
            <span className={`text-[12.5px] ${test.tone === "ok" ? "text-ok" : test.tone === "err" ? "text-err" : "text-ink-faint"}`}>
              {test.tone === "ok" ? "✓ " : test.tone === "err" ? "✗ " : ""}{test.text}
            </span>
            {m.providerEnabled && !m.removed && <TestModelButton providerId={m.providerId} modelId={m.modelId} publicId={m.publicId} />}
          </td>
          <td className={td}><ModelSwitch providerId={m.providerId} modelId={m.modelId} publicId={m.publicId} enabled={m.enabled} disabled={!m.providerEnabled || m.removed} /></td>
          <td className={`${td} ${tdWrap}`}>
            {isDefault || !m.enabled || !m.providerEnabled ? null : <MakeDefaultButton publicId={m.publicId} />}
            {m.manual && <RemoveManualModelButton providerId={m.providerId} modelId={m.modelId} publicId={m.publicId} />}
          </td>
        </tr>
      ),
    };
  });

  return (
    <>
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway", href: "/ai" }, { label: "Models" }]}
        title="Models"
        sub="Listed by each connected provider (its /models). Model ids are provider/model; a bare id goes to the default provider. Turn a model off and the gateway answers 400 model_not_enabled."
        actions={<RefreshModelsButton />}
      />
      {provider && (
        <Card title="Advisor notes" meta={`07:00 and 19:00 ${zoneName()} · your provider`}>
          <p className="m-0 mb-3 text-[13px] text-ink-soft">{ALWAYS_APP ? `Short notes for ${ALWAYS_APP} and up to 3 apps that need attention` : "Short notes for up to 3 apps that need attention"}, written from scrubbed console data. They show with the other AI notes.</p>
          <AdvisorNotesControls enabled={advisor.enabled} model={advisor.model} defaultLabel={provider.model}
            models={rows.filter((m) => m.enabled && m.providerEnabled).map((m) => m.publicId)} />
        </Card>
      )}
      {ag !== "none" && <AntigravitySection view={ag} now={now} />}
      <h2 className="m-0 mt-2 text-[13px] font-medium uppercase tracking-wide text-ink-soft">Providers · Bring your own key</h2>
      <Card flush>
        {list.length === 0 ? (
          <EmptyState title="No models yet" action={<Link href="/ai/providers" className={buttonClass({ size: "sm" })}>Bring your own key</Link>}>
            Connect a provider and its model list appears here.
          </EmptyState>
        ) : (
          <>
            {AI_EXTRAS.modelSync && customs.some((p) => p.enabled) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-[18px] py-3 max-[720px]:px-3.5">
                <span className="font-mono text-[12.5px] text-ink-soft">{sync ? syncStatusText(sync, now) : "Auto-sync: on · status unavailable"}</span>
                {sync?.error && <span className="text-[12.5px] text-err">Last run: {sync.error}</span>}
                <span className="ml-auto max-[720px]:ml-0"><SyncNowButton /></span>
              </div>
            )}
            <div className="flex flex-wrap gap-2 px-[18px] pt-3.5 max-[720px]:px-3.5">
              {providers.filter((p) => p.enabled).map((p) => <ScanAllButton key={p.id} providerId={p.id} name={p.name} />)}
            </div>
            <ListFilter placeholder="Filter models" states={[["ok", "On"], ["off", "Off"]]} chips={[["working", "Working only"]]} head={["Model id", "Provider", "Context", "Max output", "Test", "Enabled", ""]} rows={list} />
          </>
        )}
      </Card>
      {customs.length > 0 && (
        <Card title="Custom servers">
          <div className="flex flex-col gap-4">
            {customs.map((p) => <AddModelIdForm key={p.id} providerId={p.id} providerName={p.name} />)}
          </div>
        </Card>
      )}
      <p className="m-0 text-[12.5px] text-ink-faint">
        Gemini presets offer Google models only; a custom server offers every model it lists, plus model ids you add. Every 6 hours Watchbell syncs each custom server&apos;s list: new models are tested and turned on when they answer, models the server no longer lists are switched off and marked removed, and a model you switch off here stays off. The default model is what the console&apos;s own AI (Ask AI, summaries, Playground) uses when none is picked.
      </p>
    </>
  );
}
